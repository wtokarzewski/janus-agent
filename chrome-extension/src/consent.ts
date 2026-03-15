/**
 * Consent banner detection and dismissal — structural approach.
 *
 * No hardcoded text. Detection uses DOM structure:
 * - Container attributes: id/class containing cookie/consent/gdpr/privacy
 * - ARIA roles: dialog, alertdialog, aria-modal
 * - Visual position: fixed/sticky, z-index > 100 (overlay)
 * - Button heuristic: largest visible button in overlay
 */

// Selector for consent-related overlay containers
const CONSENT_CONTAINER_SELECTOR = [
  '[id*="cookie" i]', '[id*="consent" i]', '[id*="gdpr" i]', '[id*="privacy" i]',
  '[class*="cookie" i]', '[class*="consent" i]', '[class*="gdpr" i]',
  '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
].join(',');

function isOverlay(el: Element): boolean {
  const style = getComputedStyle(el);
  return style.position === 'fixed'
    || style.position === 'sticky'
    || parseInt(style.zIndex, 10) > 100;
}

function isVisibleEl(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isInteractiveTag(el: Element): boolean {
  return el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button';
}

/**
 * Check if an element is an interactive element inside a consent overlay.
 * Used for the `cookie_accept` semantic hint in snapshots.
 */
export function isConsentElement(el: Element): boolean {
  const container = el.closest(CONSENT_CONTAINER_SELECTOR);
  if (!container) return false;
  if (!isInteractiveTag(el)) return false;
  return isOverlay(container);
}

/**
 * Find and click the most prominent button in a consent overlay.
 * Returns whether the banner was dismissed.
 */
export async function dismissCookieBanner(): Promise<{ ok: boolean; result?: unknown }> {
  const containers = document.querySelectorAll(CONSENT_CONTAINER_SELECTOR);

  for (const container of containers) {
    if (!isOverlay(container) || !isVisibleEl(container)) continue;

    const buttons = [...container.querySelectorAll('button, a, [role="button"]')]
      .filter(b => isVisibleEl(b)) as HTMLElement[];
    if (buttons.length === 0) continue;

    // Heuristic: largest visible button is usually the primary accept action
    const sorted = buttons
      .map(btn => ({ btn, area: btn.getBoundingClientRect().width * btn.getBoundingClientRect().height }))
      .sort((a, b) => b.area - a.area);

    const target = sorted[0].btn;
    target.click();
    await new Promise<void>(r => setTimeout(r, 500));

    const stillVisible = isVisibleEl(container);
    return {
      ok: true,
      result: {
        dismissed: !stillVisible,
        clicked: (target.textContent ?? '').trim().slice(0, 60),
        containerId: container.id || container.className.toString().slice(0, 40),
      },
    };
  }

  return { ok: true, result: { dismissed: false, reason: 'No consent overlay detected' } };
}
