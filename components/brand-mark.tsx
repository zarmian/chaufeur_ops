import { brandAssetSrc, type Branding } from '@/lib/branding';
import { cn } from '@/lib/utils';

/**
 * The company's logo, or its name when there isn't one.
 *
 * Both variants are rendered and one is hidden by CSS rather than picking in
 * JavaScript: the theme is decided by the `.dark` class on the document, and
 * a server render has no way to know which will apply. Choosing here would
 * flash the wrong logo on every load.
 *
 * The image is served through this application's own route so the signed URL
 * never appears in the markup, where it would go stale in a cached page.
 */
export function BrandMark({
  branding,
  className,
  imageClassName,
}: {
  branding: Pick<Branding, 'tradingName' | 'logoLightUrl' | 'logoDarkUrl'>;
  className?: string;
  imageClassName?: string;
}) {
  const { tradingName, logoLightUrl, logoDarkUrl } = branding;

  if (!logoLightUrl && !logoDarkUrl) {
    return (
      <span className={cn('text-sm font-semibold tracking-tight', className)}>
        {tradingName}
      </span>
    );
  }

  // Either variant alone is used for both themes — a customer who uploads one
  // logo gets that logo everywhere rather than their name in dark mode.
  const light = brandAssetSrc(
    logoLightUrl ? 'logoLightUrl' : 'logoDarkUrl',
    logoLightUrl ?? logoDarkUrl,
  );
  const dark = brandAssetSrc(
    logoDarkUrl ? 'logoDarkUrl' : 'logoLightUrl',
    logoDarkUrl ?? logoLightUrl,
  );

  return (
    <span className={cn('inline-flex items-center', className)}>
      {/*
        `height` matches the `h-7` these render at, so the line box is the
        right size before the file arrives. No `width`: the logo belongs to
        whoever installed this and its aspect ratio is not ours to assert —
        a fixed width would squash somebody's wordmark. Height being fixed
        keeps the shift horizontal and small.
      */}
      {light ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={light}
          alt={tradingName}
          height={28}
          className={cn('h-7 w-auto object-contain dark:hidden', imageClassName)}
        />
      ) : null}
      {dark ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={dark}
          alt={tradingName}
          height={28}
          className={cn(
            'hidden h-7 w-auto object-contain dark:block',
            imageClassName,
          )}
        />
      ) : null}
    </span>
  );
}
