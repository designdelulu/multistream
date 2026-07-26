import { buildEmbedUrl } from '../platforms';
import type { StreamRef } from '../types';

const LAZY_ROOT_MARGIN = '120px';

export function shouldLazyLoadStream(stream: StreamRef): boolean {
  return stream.platform !== 'kick';
}

function reloadIframeSrc(iframe: HTMLIFrameElement, url: string): void {
  iframe.removeAttribute('src');
  iframe.src = url;
}

function loadStreamIframe(card: HTMLElement): void {
  const iframe = card.querySelector<HTMLIFrameElement>('.stream-card__iframe');
  if (!iframe || iframe.getAttribute('src')) {
    return;
  }

  const embedSrc = iframe.dataset.embedSrc;
  if (!embedSrc) {
    return;
  }

  reloadIframeSrc(iframe, embedSrc);
  card.dataset.loaded = 'true';
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        loadStreamIframe(entry.target as HTMLElement);
      }
    }
  },
  { rootMargin: LAZY_ROOT_MARGIN },
);

export function observeStreamCard(card: HTMLElement): void {
  observer.observe(card);
  const rect = card.getBoundingClientRect();
  const inView =
    rect.top < window.innerHeight + 120 && rect.bottom > -120;
  if (inView) {
    loadStreamIframe(card);
  }
}

export function unobserveStreamCard(card: HTMLElement): void {
  observer.unobserve(card);
}

export function setStreamIframeSource(
  iframe: HTMLIFrameElement,
  stream: StreamRef,
  options?: { autoplay?: boolean; forceReload?: boolean },
): void {
  const url = buildEmbedUrl(stream, stream.muted, {
    autoplay: options?.autoplay ?? true,
  });
  iframe.dataset.embedSrc = url;

  const isLoaded = Boolean(iframe.getAttribute('src'));
  if (!isLoaded && !options?.forceReload) {
    return;
  }

  reloadIframeSrc(iframe, url);
}

export function clearStreamIframe(iframe: HTMLIFrameElement): void {
  iframe.removeAttribute('src');
  delete iframe.dataset.embedSrc;
}
