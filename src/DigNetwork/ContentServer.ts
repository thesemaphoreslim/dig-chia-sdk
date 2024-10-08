import fs from "fs";
import http from "http";
import { URL } from "url";
import { Readable } from "stream";
import { getOrCreateSSLCerts } from "../utils/ssl";
import { formatHost } from "../utils/network";

export class ContentServer {
  private ipAddress: string;
  private storeId: string;
  private static certPath: string;
  private static keyPath: string;
  private static readonly port = 4161;

  constructor(ipAddress: string, storeId: string) {
    this.ipAddress = ipAddress;
    this.storeId = storeId;

    if (!ContentServer.certPath || !ContentServer.keyPath) {
      const { certPath, keyPath } = getOrCreateSSLCerts();
      ContentServer.certPath = certPath;
      ContentServer.keyPath = keyPath;
    }
  }

  // Method to get the content of a specified key from the peer, with optional challenge query
  public async getKey(
    key: string,
    rootHash: string,
    challengeHex?: string
  ): Promise<string> {
    // Construct the base URL
    let url = `https://${formatHost(this.ipAddress)}:${ContentServer.port}/chia.${this.storeId}.${rootHash}/${key}`;

    // If a challenge is provided, append it as a query parameter
    if (challengeHex) {
      url += `?challenge=${challengeHex}`;
    }

    return this.fetchWithRetries(url);
  }

  // Method to get the payment address from the peer
  public async getPaymentAddress(): Promise<string | null> {
    console.log(`Fetching payment address from peer ${this.ipAddress}...`);

    try {
      const wellKnown = await this.getWellKnown();
      return wellKnown.xch_address;
    } catch (error: any) {
      console.error(
        `Failed to fetch payment address from ${this.ipAddress}: ${error.message}`
      );
      return null;
    }
  }

  // Method to get the .well-known information
  public async getWellKnown(): Promise<any> {
    const url = `https://${formatHost(this.ipAddress)}:${ContentServer.port}/.well-known`;
    return this.fetchJson(url);
  }

  // Method to get the list of known stores
  public async getKnownStores(): Promise<any> {
    const url = `https://${formatHost(this.ipAddress)}:${ContentServer.port}/.well-known/stores`;
    return this.fetchJson(url);
  }

  // Method to get the index of all stores
  public async getStoresIndex(): Promise<any> {
    const url = `https://${formatHost(this.ipAddress)}:${ContentServer.port}/`;
    return this.fetchJson(url);
  }

  // Method to get the index of keys in a store
  public async getKeysIndex(rootHash?: string): Promise<any> {
    let udi = `chia.${this.storeId}`;

    if (rootHash) {
      udi += `.${rootHash}`;
    }

    const url = `https://${formatHost(this.ipAddress)}:${ContentServer.port}/${udi}`;
    return this.fetchJson(url);
  }

  // Method to check if a specific key exists (HEAD request)
  public async headKey(
    key: string,
    rootHash?: string
  ): Promise<{ success: boolean; headers?: http.IncomingHttpHeaders }> {
    let udi = `chia.${this.storeId}`;

    if (rootHash) {
      udi += `.${rootHash}`;
    }

    const url = `https://${formatHost(this.ipAddress)}:${ContentServer.port}/${udi}/${key}`;
    return this.head(url);
  }

  // Method to check if a specific store exists (HEAD request)
  public async headStore(options?: { hasRootHash: string }): Promise<{
    success: boolean;
    headers?: http.IncomingHttpHeaders;
  }> {
    let url = `https://${formatHost(this.ipAddress)}:${ContentServer.port}/chia.${this.storeId}`;

    if (options?.hasRootHash) {
      url += `?hasRootHash=${options.hasRootHash}`;
    }

    return this.head(url);
  }

  public async hasRootHash(rootHash: string): Promise<boolean> {
    const { success, headers } = await this.headStore({
      hasRootHash: rootHash,
    });
    if (success) {
      return headers?.["x-has-root-hash"] === "true";
    }
    return false;
  }

  public streamKey(key: string, rootHash?: string): Promise<Readable> {
    let udi = `chia.${this.storeId}`;

    if (rootHash) {
      udi += `.${rootHash}`;
    }

    return new Promise((resolve, reject) => {
      const url = `https://${formatHost(this.ipAddress)}:${ContentServer.port}/${udi}/${key}`;
      const urlObj = new URL(url);

      const requestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || ContentServer.port,
        path: urlObj.pathname + urlObj.search,
        method: "GET",
      };

      const request = http.request(requestOptions, (response) => {
        if (response.statusCode === 200) {
          resolve(response); // Resolve with the readable stream
        } else if (response.statusCode === 301 || response.statusCode === 302) {
          // Handle redirects
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            this.streamKey(redirectUrl).then(resolve).catch(reject);
          } else {
            reject(new Error("Redirected without a location header"));
          }
        } else {
          reject(
            new Error(
              `Failed to retrieve data from ${url}. Status code: ${response.statusCode}`
            )
          );
        }
      });

      request.on("error", (error) => {
        console.error(`GET Request error for ${url}:`, error);
        reject(error);
      });

      request.end();
    });
  }

  // Helper method to perform HEAD requests
  private async head(
    url: string,
    maxRedirects: number = 5
  ): Promise<{ success: boolean; headers?: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      try {
        // Parse the input URL
        const urlObj = new URL(url);

        const requestOptions = {
          hostname: urlObj.hostname,
          port:
            urlObj.port ||
            (urlObj.protocol === "http:" ? 80 : ContentServer.port),
          path: urlObj.pathname + urlObj.search,
          method: "HEAD",
          key: fs.readFileSync(ContentServer.keyPath),
          cert: fs.readFileSync(ContentServer.certPath),
          rejectUnauthorized: false,
        };

        const request = http.request(requestOptions, (response) => {
          const { statusCode, headers } = response;

          // If status code is 2xx, return success
          if (statusCode && statusCode >= 200 && statusCode < 300) {
            resolve({ success: true, headers });
          }
          // Handle 3xx redirection
          else if (
            statusCode &&
            statusCode >= 300 &&
            statusCode < 400 &&
            headers.location
          ) {
            if (maxRedirects > 0) {
              let redirectUrl = headers.location;

              // Check if the redirect URL is relative
              if (!/^https?:\/\//i.test(redirectUrl)) {
                // Resolve the relative URL based on the original URL
                redirectUrl = new URL(redirectUrl, url).toString();
                console.log(`Resolved relative redirect to: ${redirectUrl}`);
              } else {
                console.log(`Redirecting to: ${redirectUrl}`);
              }

              // Recursively follow the redirection
              this.head(redirectUrl, maxRedirects - 1)
                .then(resolve)
                .catch(reject);
            } else {
              reject({ success: false, message: "Too many redirects" });
            }
          } else {
            // For other status codes, consider it a failure
            resolve({ success: false });
          }
        });

        request.on("error", (error) => {
          console.error(`HEAD ${url}:`, error.message);
          reject({ success: false });
        });

        request.end();
      } catch (err) {
        console.error(`Invalid URL: ${url}`, err);
        reject({ success: false, message: "Invalid URL" });
      }
    });
  }

  // Helper method to fetch JSON data from a URL
  private async fetchJson(url: string): Promise<any> {
    const response = await this.fetchWithRetries(url);
    return JSON.parse(response);
  }

  // Helper method to fetch content with retries and redirection handling
  private async fetchWithRetries(url: string): Promise<string> {
    let attempt = 0;
    const maxRetries = 1;
    const initialDelay = 2000; // 2 seconds
    const maxDelay = 10000; // 10 seconds
    const delayMultiplier = 1.5;
    let delay = initialDelay;

    while (attempt < maxRetries) {
      try {
        return await this.fetch(url);
      } catch (error: any) {
        if (attempt < maxRetries - 1) {
          console.warn(
            `Attempt ${attempt + 1} failed: ${error.message}. Retrying in ${
              delay / 1000
            } seconds...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(maxDelay, delay * delayMultiplier);
        } else {
          console.error(`Failed to retrieve data from ${url}. Aborting.`);
          throw new Error(`Failed to retrieve data: ${error.message}`);
        }
      }
      attempt++;
    }
    throw new Error(
      `Failed to retrieve data from ${url} after ${maxRetries} attempts.`
    );
  }

  // Core method to fetch content from a URL with a 5-second inactivity timeout
  private async fetch(url: string, maxRedirects: number = 5): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const timeoutDuration = 5000; // 5 seconds

      let timeout: NodeJS.Timeout | null = null; // Initialize timeout

      const requestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || ContentServer.port,
        path: urlObj.pathname + urlObj.search, // Include query params
        method: "GET",
        key: fs.readFileSync(ContentServer.keyPath),
        cert: fs.readFileSync(ContentServer.certPath),
        rejectUnauthorized: false,
      };

      const request = http.request(requestOptions, (response) => {
        let data = "";

        // Set timeout for inactivity
        timeout = setTimeout(() => {
          console.error(
            `Request timeout: No data received for ${
              timeoutDuration / 1000
            } seconds.`
          );
          request.destroy(); // Use destroy instead of abort
          reject(
            new Error(
              `Request timed out after ${
                timeoutDuration / 1000
              } seconds of inactivity`
            )
          );
        }, timeoutDuration);

        const resetTimeout = () => {
          if (timeout) {
            clearTimeout(timeout);
          }
          timeout = setTimeout(() => {
            console.error(
              `Request timeout: No data received for ${
                timeoutDuration / 1000
              } seconds.`
            );
            request.destroy(); // Use destroy instead of abort
            reject(
              new Error(
                `Request timed out after ${
                  timeoutDuration / 1000
                } seconds of inactivity`
              )
            );
          }, timeoutDuration);
        };

        if (response.statusCode === 200) {
          response.on("data", (chunk) => {
            data += chunk;
            resetTimeout(); // Reset the timeout every time data is received
          });

          response.on("end", () => {
            if (timeout) {
              clearTimeout(timeout);
            }
            resolve(data);
          });
        } else if (
          (response.statusCode === 301 || response.statusCode === 302) &&
          response.headers.location
        ) {
          // Handle redirects
          if (maxRedirects > 0) {
            const redirectUrl = new URL(response.headers.location, url); // Resolve relative URLs based on the original URL
            if (timeout) {
              clearTimeout(timeout);
            }
            this.fetch(redirectUrl.toString(), maxRedirects - 1)
              .then(resolve)
              .catch(reject);
          } else {
            reject(new Error("Too many redirects"));
          }
        } else {
          if (timeout) {
            clearTimeout(timeout);
          }
          reject(
            new Error(
              `Failed to retrieve data from ${url}. Status code: ${response.statusCode}`
            )
          );
        }
      });

      request.on("error", (error: NodeJS.ErrnoException) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        console.error(`GET ${url}:`, error.message);
        reject(error);
      });

      request.end();
    });
  }
}
