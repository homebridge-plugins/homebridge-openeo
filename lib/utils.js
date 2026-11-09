export const toBaseUrl = (host) => (/^https?:\/\//i.test(host) ? host : `http://${host}`);

export const toBool = (v) => v === true || v === 1 || (typeof v === 'string' && (v.toLowerCase() === 'true' || v === '1'));
export const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
export const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
