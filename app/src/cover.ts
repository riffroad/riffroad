/** Pictures asked for only once their box comes near the screen (a library of a thousand songs
 * would otherwise ask for every one at once). */
let watcher: IntersectionObserver | null = null;
const pending = new WeakMap<Element, () => void>();

function whenSeen(box: HTMLElement, load: () => void): void {
  if (typeof IntersectionObserver === 'undefined') return load();
  watcher ??= new IntersectionObserver(
    (seen) => {
      for (const e of seen) {
        if (!e.isIntersecting) continue;
        watcher!.unobserve(e.target);
        pending.get(e.target)?.();
        pending.delete(e.target);
      }
    },
    { rootMargin: '600px' },
  );
  pending.set(box, load);
  watcher.observe(box);
}

/** A song's picture, or a generated one (initials on a gradient) until or unless there is one.
 * `url` as a function: asked for when the picture comes near the screen. */
export function coverElement(
  title: string,
  artist: string,
  url: (() => Promise<string | null>) | Promise<string | null> | string | null,
  className = '',
): HTMLElement {
  const box = document.createElement('div');
  box.className = `cover ${className} placeholder`;
  let hash = 0;
  for (const c of title + artist) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  box.style.background = `linear-gradient(135deg, hsl(${hue} 70% 46%), hsl(${(hue + 50) % 360} 70% 22%))`;
  box.textContent = initials(title);
  const show = (src: string | null): void => {
    if (!src) return;
    const img = document.createElement('img');
    img.alt = '';
    // Decoded off the main thread: a library opening shows dozens at once.
    img.decoding = 'async';
    img.src = src;
    img.onload = () => {
      box.classList.remove('placeholder');
      box.replaceChildren(img);
      // The gradient stays under the picture while it fades in (`.cover img`), then goes.
      setTimeout(() => (box.style.background = ''), 220);
    };
  };
  if (typeof url === 'function') whenSeen(box, () => void url().then(show));
  else void Promise.resolve(url).then(show);
  return box;
}

export function initials(title: string): string {
  const words = title.split(/[\s\-–—_()[\]]+/).filter((w) => /\p{L}|\d/u.test(w));
  return (words.slice(0, 2).map((w) => w[0]).join('') || '♪').toUpperCase();
}
