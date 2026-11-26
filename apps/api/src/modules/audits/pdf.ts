import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CANDIDATES = [
  process.env.LEADCOLLECTOR_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean) as string[];

export function chromePath(): string | null {
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** Print an HTML file to PDF with a headless browser in a throwaway profile,
 * never the automation profile the collector's worker lives in. */
export function htmlToPdf(htmlFile: string, pdfFile: string, timeoutMs = 120_000): Promise<void> {
  const chrome = chromePath();
  if (!chrome) return Promise.reject(new Error('no Chrome or Edge found; set LEADCOLLECTOR_CHROME'));
  const profile = mkdtempSync(join(tmpdir(), 'lc-pdf-'));
  return new Promise((resolve, reject) => {
    execFile(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        `--user-data-dir=${profile}`,
        '--no-pdf-header-footer',
        '--run-all-compositor-stages-before-draw',
        `--print-to-pdf=${pdfFile}`,
        pathToFileURL(htmlFile).href,
      ],
      { timeout: timeoutMs, windowsHide: true },
      (error) => {
        rmSync(profile, { recursive: true, force: true });
        if (error && !existsSync(pdfFile)) reject(error);
        else resolve();
      },
    );
  });
}
