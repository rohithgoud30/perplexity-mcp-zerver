#!/usr/bin/env node

// ─── TYPE DECLARATIONS ─────────────────────────────────────────────────
declare global {
  interface Window {
    chrome: {
      app: {
        InstallState: {
          DISABLED: string;
          INSTALLED: string;
          NOT_INSTALLED: string;
        };
        RunningState: {
          CANNOT_RUN: string;
          READY_TO_RUN: string;
          RUNNING: string;
        };
        getDetails: () => void;
        getIsInstalled: () => void;
        installState: () => void;
        isInstalled: boolean;
        runningState: () => void;
      };
      runtime: {
        OnInstalledReason: {
          CHROME_UPDATE: string;
          INSTALL: string;
          SHARED_MODULE_UPDATE: string;
          UPDATE: string;
        };
        PlatformArch: {
          ARM: string;
          ARM64: string;
          MIPS: string;
          MIPS64: string;
          X86_32: string;
          X86_64: string;
        };
        PlatformNaclArch: {
          ARM: string;
          MIPS: string;
          PNACL: string;
          X86_32: string;
          X86_64: string;
        };
        PlatformOs: {
          ANDROID: string;
          CROS: string;
          LINUX: string;
          MAC: string;
          OPENBSD: string;
          WIN: string;
        };
        RequestUpdateCheckStatus: {
          NO_UPDATE: string;
          THROTTLED: string;
          UPDATE_AVAILABLE: string;
        };
      };
    };
  }
}

export {}; // This ensures the file is treated as a module

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import puppeteer, { Browser, Page } from 'puppeteer';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url'; // Added for ES Module path resolution
import crypto from 'crypto';

// ─── INTERFACES ────────────────────────────────────────────────────────
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// ─── CONFIGURATION ─────────────────────────────────────────────────────
const CONFIG = {
  SEARCH_COOLDOWN: 5000,
  PAGE_TIMEOUT: 180000, 
  SELECTOR_TIMEOUT: 90000,
  MAX_RETRIES: 10,
  MCP_TIMEOUT_BUFFER: 60000,
  ANSWER_WAIT_TIMEOUT: 120000,
  RECOVERY_WAIT_TIME: 15000,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  
  // Adaptive timeout profiles (in ms)
  TIMEOUT_PROFILES: {
    navigation: 45000,
    selector: 15000,
    content: 120000,
    recovery: 30000
  }
} as const;

// Safe logging function to prevent JSON parsing issues
function safeLog(message: string | unknown, additionalData?: unknown): void {
  // Prefix logs to distinguish them from JSON data
  const prefix = '[LOG:INFO]';

  // Format message
  const formattedMessage =
    message instanceof Error ? message.message : String(message);

  // Format additional data if present
  const additionalInfo =
    additionalData !== undefined
      ? ' ' +
        (additionalData instanceof Error
          ? additionalData.message
          : String(additionalData))
      : '';

  // Use console.error for all logs to avoid interfering with JSON communication
  console.error(`${prefix} ${formattedMessage}${additionalInfo}`);
}

// Error/warning specific variants
function logError(message: string | unknown, additionalData?: unknown): void {
  const prefix = '[LOG:ERROR]';
  const formattedMessage =
    message instanceof Error ? message.message : String(message);
  const additionalInfo =
    additionalData !== undefined
      ? ' ' +
        (additionalData instanceof Error
          ? additionalData.message
          : String(additionalData))
      : '';
  console.error(`${prefix} ${formattedMessage}${additionalInfo}`);
}

function logWarn(message: string | unknown, additionalData?: unknown): void {
  const prefix = '[LOG:WARN]';
  const formattedMessage =
    message instanceof Error ? message.message : String(message);
  const additionalInfo =
    additionalData !== undefined
      ? ' ' +
        (additionalData instanceof Error
          ? additionalData.message
          : String(additionalData))
      : '';
  console.error(`${prefix} ${formattedMessage}${additionalInfo}`);
}

// ─── MAIN SERVER CLASS ─────────────────────────────────────────────────
class PerplexityMCPServer {
  // Browser state
  private browser: Browser | null = null;
  private page: Page | null = null;
  private isInitializing = false;
  private searchInputSelector: string = 'textarea[placeholder*="Ask"]';
  private lastSearchTime = 0;
  
  // Database state
  private db: Database.Database;
  
  // Server state
  private server: Server;
  private idleTimeout: NodeJS.Timeout | null = null;
  private readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  
  private operationCount = 0;

  constructor() {
    this.server = new Server(
      { name: 'perplexity-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    // Initialize SQLite database (chat history) in the server's directory
    // Use import.meta.url for path relative to the current module file
    const dbPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'chat_history.db');
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    this.db = new Database(dbPath, { fileMustExist: false });
    this.initializeDatabase();

    this.setupToolHandlers();

    // Graceful shutdown on SIGINT
    process.on('SIGINT', async () => {
      if (this.browser) {
        await this.browser.close();
      }
      if (this.db) {
        this.db.close();
      }
      await this.server.close();
      process.exit(0);
    });
  }

  // ─── DATABASE METHODS ────────────────────────────────────────────────

  private initializeDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chat_id) REFERENCES chats(id)
      )
    `);
  }

  private getChatHistory(chatId: string): ChatMessage[] {
    const messages = this.db
      .prepare(
        'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY created_at ASC'
      )
      .all(chatId);
    return messages as ChatMessage[];
  }

  private saveChatMessage(chatId: string, message: ChatMessage) {
    // Ensure chat exists
    this.db.prepare('INSERT OR IGNORE INTO chats (id) VALUES (?)').run(chatId);
    // Save the message
    this.db
      .prepare(
        'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)'
      )
      .run(chatId, message.role, message.content);
  }

  // ─── BROWSER / PUPPETEER METHODS ───────────────────────────────────────

  private async initializeBrowser() {
    if (this.isInitializing) {
      safeLog('Browser initialization already in progress...');
      return;
    }
    this.isInitializing = true;
    try {
      if (this.browser) {
        await this.browser.close();
      }
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1920,1080',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      });
      this.page = await this.browser.newPage();
      await this.setupBrowserEvasion();
      await this.page.setViewport({ width: 1920, height: 1080 });
      await this.page.setUserAgent(CONFIG.USER_AGENT);
      this.page.setDefaultNavigationTimeout(CONFIG.PAGE_TIMEOUT);
      await this.navigateToPerplexity();
    } catch (error) {
      logError('Browser initialization failed:', error);
      throw error;
    } finally {
      this.isInitializing = false;
    }
  }

  private async navigateToPerplexity() {
    if (!this.page) throw new Error('Page not initialized');
    try {
      safeLog('Navigating to Perplexity.ai...');
      
      // Try multiple waitUntil strategies in case one fails
      const waitUntilOptions = ['networkidle2', 'domcontentloaded', 'load'] as const;
      let navigationSuccessful = false;
      
      for (const waitUntil of waitUntilOptions) {
        if (navigationSuccessful) break;
        
        try {
          safeLog(`Attempting navigation with waitUntil: ${waitUntil}`);
          await this.page.goto('https://www.perplexity.ai/', {
            waitUntil,
            timeout: CONFIG.PAGE_TIMEOUT
          });
          navigationSuccessful = true;
          safeLog(`Navigation successful with waitUntil: ${waitUntil}`);
        } catch (navError) {
          logWarn(`Navigation with waitUntil: ${waitUntil} failed:`, navError);
          // If this is the last option, we'll let the error propagate to the outer catch
          if (waitUntil !== waitUntilOptions[waitUntilOptions.length - 1]) {
            safeLog('Trying next navigation strategy...');
          }
        }
      }
      
      if (!navigationSuccessful) {
        throw new Error('All navigation strategies failed');
      }
      
      // Allow extra time for the page to settle and JavaScript to initialize
      safeLog('Waiting for page to settle...');
      await new Promise((resolve) => setTimeout(resolve, 7000)); // Increased from 5000 to 7000
      
      // Check if page loaded correctly
      const pageTitle = await this.page.title().catch(() => '');
      const pageUrl = this.page.url();
      safeLog(`Page loaded: ${pageUrl} (${pageTitle})`);
      
      // Verify we're on the correct domain
      if (!pageUrl.includes('perplexity.ai')) {
        logError(`Unexpected URL: ${pageUrl}`);
        throw new Error(`Navigation redirected to unexpected URL: ${pageUrl}`);
      }
      
      safeLog('Waiting for search input...');
      const searchInput = await this.waitForSearchInput();
      if (!searchInput) {
        logError('Search input not found, taking screenshot for debugging');
        await this.page.screenshot({ path: 'debug_no_search_input.png', fullPage: true });
        throw new Error('Search input not found after navigation');
      }
      
      safeLog('Navigation to Perplexity.ai completed successfully');
    } catch (error) {
      logError('Navigation failed:', error);
      
      // Try to take a screenshot of the failed state if possible
      try {
        if (this.page) {
          await this.page.screenshot({ path: 'debug_navigation_failed.png', fullPage: true });
          safeLog('Captured screenshot of failed navigation state');
        }
      } catch (screenshotError) {
        logError('Failed to capture screenshot:', screenshotError);
      }
      
      throw error;
    }
  }

  private async setupBrowserEvasion() {
    if (!this.page) return;
    await this.page.evaluateOnNewDocument(() => {
      // Overwrite navigator properties to help avoid detection
      Object.defineProperties(navigator, {
        webdriver: { get: () => undefined },
        hardwareConcurrency: { get: () => 8 },
        deviceMemory: { get: () => 8 },
        platform: { get: () => 'Win32' },
        languages: { get: () => ['en-US', 'en'] },
        permissions: {
          get: () => ({
            query: async () => ({ state: 'prompt' })
          })
        }
      });
      // Inject Chrome-specific properties
      window.chrome = {
        app: {
          InstallState: {
            DISABLED: 'disabled',
            INSTALLED: 'installed',
            NOT_INSTALLED: 'not_installed'
          },
          RunningState: {
            CANNOT_RUN: 'cannot_run',
            READY_TO_RUN: 'ready_to_run',
            RUNNING: 'running'
          },
          getDetails: function () {},
          getIsInstalled: function () {},
          installState: function () {},
          isInstalled: false,
          runningState: function () {}
        },
        runtime: {
          OnInstalledReason: {
            CHROME_UPDATE: 'chrome_update',
            INSTALL: 'install',
            SHARED_MODULE_UPDATE: 'shared_module_update',
            UPDATE: 'update'
          },
          PlatformArch: {
            ARM: 'arm',
            ARM64: 'arm64',
            MIPS: 'mips',
            MIPS64: 'mips64',
            X86_32: 'x86-32',
            X86_64: 'x86-64'
          },
          PlatformNaclArch: {
            ARM: 'arm',
            MIPS: 'mips',
            PNACL: 'pnacl',
            X86_32: 'x86-32',
            X86_64: 'x86-64'
          },
          PlatformOs: {
            ANDROID: 'android',
            CROS: 'cros',
            LINUX: 'linux',
            MAC: 'mac',
            OPENBSD: 'openbsd',
            WIN: 'win'
          },
          RequestUpdateCheckStatus: {
            NO_UPDATE: 'no_update',
            THROTTLED: 'throttled',
            UPDATE_AVAILABLE: 'update_available'
          }
        }
      };
    });
  }

  private async waitForSearchInput(
    timeout = CONFIG.SELECTOR_TIMEOUT
  ): Promise<string | null> {
    if (!this.page) return null;
    const possibleSelectors = [
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="Search"]',
      'textarea.w-full',
      'textarea[rows="1"]',
      '[role="textbox"]',
      'textarea'
    ];
    for (const selector of possibleSelectors) {
      try {
        const element = await this.page.waitForSelector(selector, {
          timeout: 5000,
          visible: true
        });
        if (element) {
          const isInteractive = await this.page.evaluate((sel) => {
            const el = document.querySelector(sel);
            return el && !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true';
          }, selector);
          if (isInteractive) {
            safeLog(`Found working search input: ${selector}`);
            this.searchInputSelector = selector;
            return selector;
          }
        }
      } catch (error) {
        logWarn(`Selector '${selector}' not found or not interactive`);
      }
    }
    // Take a screenshot for debugging if none is found
    await this.page.screenshot({ path: 'debug_search_not_found.png', fullPage: true });
    logError('No working search input found');
    return null;
  }

  private async checkForCaptcha(): Promise<boolean> {
    if (!this.page) return false;
    const captchaIndicators = [
      '[class*="captcha"]',
      '[id*="captcha"]',
      'iframe[src*="captcha"]',
      'iframe[src*="recaptcha"]',
      'iframe[src*="turnstile"]',
      '#challenge-running',
      '#challenge-form'
    ];
    return await this.page.evaluate((selectors) => {
      return selectors.some((selector) => !!document.querySelector(selector));
    }, captchaIndicators);
  }

  private determineRecoveryLevel(error?: Error): number {
    if (!error) return 3; // Default to full restart if no error info
    
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('frame') || errorMsg.includes('detached')) {
      return 2; // New page for frame issues
    }
    if (errorMsg.includes('timeout') || errorMsg.includes('navigation')) {
      return 1; // Refresh for timeouts/navigation
    }
    return 3; // Full restart for other errors
  }

  private async recoveryProcedure(error?: Error) {
    const recoveryLevel = this.determineRecoveryLevel(error);
    const opId = ++this.operationCount;
    
    safeLog('Starting recovery procedure');

    try {
      switch(recoveryLevel) {
        case 1: // Page refresh
          safeLog('Attempting page refresh');
          if (this.page) {
            await this.page.reload({timeout: CONFIG.TIMEOUT_PROFILES.navigation});
          }
          break;
          
        case 2: // New page
          safeLog('Creating new page instance');
          if (this.page) {
            await this.page.close();
          }
          if (this.browser) {
            this.page = await this.browser.newPage();
            await this.setupBrowserEvasion();
            await this.page.setViewport({ width: 1920, height: 1080 });
            await this.page.setUserAgent(CONFIG.USER_AGENT);
          }
          break;
          
        case 3: // Full restart
        default:
          safeLog('Performing full browser restart');
          if (this.page) {
            await this.page.close();
          }
          if (this.browser) {
            await this.browser.close();
          }
          this.page = null;
          this.browser = null;
          await new Promise(resolve => setTimeout(resolve, CONFIG.RECOVERY_WAIT_TIME));
          await this.initializeBrowser();
          break;
      }
      
      safeLog('Recovery completed');
    } catch (recoveryError) {
      logError('Recovery failed: ' + (recoveryError instanceof Error ? recoveryError.message : String(recoveryError)));
      
      // Fall back to more aggressive recovery if initial attempt fails
      if (recoveryLevel < 3) {
        safeLog('Attempting higher level recovery');
        await this.recoveryProcedure(new Error('Fallback recovery'));
      } else {
        throw recoveryError;
      }
    }
  }

  private resetIdleTimeout() {
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
    }

    this.idleTimeout = setTimeout(async () => {
      safeLog('Browser idle timeout reached, closing browser...');
      try {
        if (this.page) {
          await this.page.close();
          this.page = null;
        }
        if (this.browser) {
          await this.browser.close();
          this.browser = null;
        }
        this.isInitializing = false; // Reset initialization flag
        safeLog('Browser cleanup completed successfully');
      } catch (error) {
        logError('Error during browser cleanup:', error);
        // Reset states even if cleanup fails
        this.page = null;
        this.browser = null;
        this.isInitializing = false;
      }
    }, this.IDLE_TIMEOUT_MS);
  }