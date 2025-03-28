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

// ─── LOGGING FUNCTIONS ─────────────────────────────────────────────────
/**
 * Safe logging function to handle all types of inputs and prevent JSON parsing errors
 * @param message Primary message or object to log
 * @param data Optional additional data to include in the log
 */
function safeLog(message: unknown, data?: unknown): void {
  let formattedMessage = '[LOG:INFO] ';
  
  // Format the primary message
  if (message instanceof Error) {
    formattedMessage += `${message.name}: ${message.message}`;
    if (message.stack) {
      formattedMessage += `\n${message.stack}`;
    }
  } else if (typeof message === 'object' && message !== null) {
    try {
      formattedMessage += JSON.stringify(message);
    } catch (e) {
      formattedMessage += `[Unstringifiable Object: ${Object.prototype.toString.call(message)}]`;
    }
  } else {
    formattedMessage += String(message);
  }
  
  // Add additional data if provided
  if (data !== undefined) {
    formattedMessage += ' ';
    if (data instanceof Error) {
      formattedMessage += `${data.name}: ${data.message}`;
      if (data.stack) {
        formattedMessage += `\n${data.stack}`;
      }
    } else if (typeof data === 'object' && data !== null) {
      try {
        formattedMessage += JSON.stringify(data);
      } catch (e) {
        formattedMessage += `[Unstringifiable Object: ${Object.prototype.toString.call(data)}]`;
      }
    } else {
      formattedMessage += String(data);
    }
  }
  
  // Use console.error to prevent JSON communication issues
  console.error(formattedMessage);
}

/**
 * Safe error logging function with error prefix
 * @param message Primary message or object to log
 * @param data Optional additional data to include in the log
 */
function logError(message: unknown, data?: unknown): void {
  let formattedMessage = '[LOG:ERROR] ';
  
  // Format the primary message
  if (message instanceof Error) {
    formattedMessage += `${message.name}: ${message.message}`;
    if (message.stack) {
      formattedMessage += `\n${message.stack}`;
    }
  } else if (typeof message === 'object' && message !== null) {
    try {
      formattedMessage += JSON.stringify(message);
    } catch (e) {
      formattedMessage += `[Unstringifiable Object: ${Object.prototype.toString.call(message)}]`;
    }
  } else {
    formattedMessage += String(message);
  }
  
  // Add additional data if provided
  if (data !== undefined) {
    formattedMessage += ' ';
    if (data instanceof Error) {
      formattedMessage += `${data.name}: ${data.message}`;
      if (data.stack) {
        formattedMessage += `\n${data.stack}`;
      }
    } else if (typeof data === 'object' && data !== null) {
      try {
        formattedMessage += JSON.stringify(data);
      } catch (e) {
        formattedMessage += `[Unstringifiable Object: ${Object.prototype.toString.call(data)}]`;
      }
    } else {
      formattedMessage += String(data);
    }
  }
  
  // Use console.error to prevent JSON communication issues
  console.error(formattedMessage);
}

/**
 * Safe warning logging function with warning prefix
 * @param message Primary message or object to log
 * @param data Optional additional data to include in the log
 */
function logWarn(message: unknown, data?: unknown): void {
  let formattedMessage = '[LOG:WARN] ';
  
  // Format the primary message
  if (message instanceof Error) {
    formattedMessage += `${message.name}: ${message.message}`;
    if (message.stack) {
      formattedMessage += `\n${message.stack}`;
    }
  } else if (typeof message === 'object' && message !== null) {
    try {
      formattedMessage += JSON.stringify(message);
    } catch (e) {
      formattedMessage += `[Unstringifiable Object: ${Object.prototype.toString.call(message)}]`;
    }
  } else {
    formattedMessage += String(message);
  }
  
  // Add additional data if provided
  if (data !== undefined) {
    formattedMessage += ' ';
    if (data instanceof Error) {
      formattedMessage += `${data.name}: ${data.message}`;
      if (data.stack) {
        formattedMessage += `\n${data.stack}`;
      }
    } else if (typeof data === 'object' && data !== null) {
      try {
        formattedMessage += JSON.stringify(data);
      } catch (e) {
        formattedMessage += `[Unstringifiable Object: ${Object.prototype.toString.call(data)}]`;
      }
    } else {
      formattedMessage += String(data);
    }
  }
  
  // Use console.error to prevent JSON communication issues
  console.error(formattedMessage);
}

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