import { readFileSync } from 'node:fs';

// Managed Login accepts its own settings document, not the application's CSS.
// Cognito omits equal light/dark tokens from its dark CSS, where Cloudscape's
// defaults then win. Keep the unused light defaults distinct so DARK renders
// the game's actual colors. Both modes must be explicit to reset earlier styles.
const modes = <T, U>(darkMode: T, lightMode: U) => ({ darkMode, lightMode });

export const managedLoginSettings = {
  categories: {
    global: {
      colorSchemeMode: 'DARK',
      spacingDensity: 'REGULAR',
      pageHeader: { enabled: false },
      pageFooter: { enabled: false },
    },
    form: { displayGraphics: false, location: { horizontal: 'CENTER', vertical: 'CENTER' } },
  },
  componentClasses: {
    buttons: { borderRadius: 9 },
    divider: modes({ borderColor: '494940ff' }, { borderColor: 'ebebf0ff' }),
    focusState: modes({ borderColor: 'f2c879ff' }, { borderColor: '0972d3ff' }),
    input: {
      borderRadius: 7,
      ...modes(
        {
          defaults: { backgroundColor: '191a15ff', borderColor: '65655aff' },
          placeholderColor: '9f9d90ff',
        },
        {
          defaults: { backgroundColor: 'ffffffff', borderColor: '7d8998ff' },
          placeholderColor: '5f6b7aff',
        },
      ),
    },
    inputLabel: modes({ textColor: 'f7f1e1ff' }, { textColor: '000716ff' }),
    inputDescription: modes({ textColor: 'b9b4a8ff' }, { textColor: '5f6b7aff' }),
    link: modes(
      { defaults: { textColor: 'd8b36aff' }, hover: { textColor: 'f2c879ff' } },
      { defaults: { textColor: '0972d3ff' }, hover: { textColor: '033160ff' } },
    ),
    optionControls: modes(
      {
        defaults: { backgroundColor: '191a15ff', borderColor: '65655aff' },
        selected: { backgroundColor: 'd8b36aff', foregroundColor: '1b180fff' },
      },
      {
        defaults: { backgroundColor: 'ffffffff', borderColor: '7d8998ff' },
        selected: { backgroundColor: '0972d3ff', foregroundColor: 'ffffffff' },
      },
    ),
    statusIndicator: modes(
      {
        error: {
          backgroundColor: '3c2421ff',
          borderColor: '936055ff',
          indicatorColor: 'f0b0a2ff',
        },
        success: {
          backgroundColor: '263a29ff',
          borderColor: '567359ff',
          indicatorColor: 'bde0bfff',
        },
        pending: { indicatorColor: 'd8b36aff' },
        warning: {
          backgroundColor: '343024ff',
          borderColor: '797053ff',
          indicatorColor: 'ead6a7ff',
        },
      },
      {
        error: { backgroundColor: 'fff7f7ff', borderColor: 'd91515ff', indicatorColor: 'd91515ff' },
        success: {
          backgroundColor: 'f2fcf3ff',
          borderColor: '037f0cff',
          indicatorColor: '037f0cff',
        },
        pending: { indicatorColor: 'AAAAAAAA' },
        warning: {
          backgroundColor: 'fffce9ff',
          borderColor: '8d6605ff',
          indicatorColor: '8d6605ff',
        },
      },
    ),
  },
  components: {
    favicon: { enabledTypes: ['SVG'] },
    form: {
      borderRadius: 16,
      backgroundImage: { enabled: false },
      ...modes(
        { backgroundColor: '24251fff', borderColor: '494940ff' },
        { backgroundColor: 'ffffffff', borderColor: 'c6c6cdff' },
      ),
      logo: { enabled: true, formInclusion: 'OUT', location: 'CENTER', position: 'TOP' },
    },
    pageBackground: {
      image: { enabled: true },
      ...modes({ color: '14130fff' }, { color: 'ffffffff' }),
    },
    pageText: modes(
      {
        bodyColor: 'f7f1e1ff',
        descriptionColor: 'b9b4a8ff',
        headingColor: 'f7f1e1ff',
      },
      { bodyColor: '414d5cff', descriptionColor: '414d5cff', headingColor: '000716ff' },
    ),
    primaryButton: modes(
      {
        defaults: { backgroundColor: 'd8b36aff', textColor: '1b180fff' },
        hover: { backgroundColor: 'f2c879ff', textColor: '1b180fff' },
        active: { backgroundColor: 'f2c879ff', textColor: '1b180fff' },
        disabled: { backgroundColor: '82714dff', borderColor: '82714dff' },
      },
      {
        defaults: { backgroundColor: '0972d3ff', textColor: 'ffffffff' },
        hover: { backgroundColor: '033160ff', textColor: 'ffffffff' },
        active: { backgroundColor: '033160ff', textColor: 'ffffffff' },
        disabled: { backgroundColor: 'ffffffff', borderColor: 'ffffffff' },
      },
    ),
    secondaryButton: modes(
      {
        defaults: {
          backgroundColor: '24251fff',
          borderColor: 'd8b36aff',
          textColor: 'f7f1e1ff',
        },
        hover: { backgroundColor: '343024ff', borderColor: 'f2c879ff', textColor: 'f7f1e1ff' },
        active: { backgroundColor: '343024ff', borderColor: 'f2c879ff', textColor: 'f7f1e1ff' },
      },
      {
        defaults: { backgroundColor: 'ffffffff', borderColor: '0972d3ff', textColor: '0972d3ff' },
        hover: { backgroundColor: 'f2f8fdff', borderColor: '033160ff', textColor: '033160ff' },
        active: { backgroundColor: 'd3e7f9ff', borderColor: '033160ff', textColor: '033160ff' },
      },
    ),
    alert: {
      borderRadius: 8,
      ...modes(
        { error: { backgroundColor: '3c2421ff', borderColor: '936055ff' } },
        { error: { backgroundColor: 'fff7f7ff', borderColor: 'd91515ff' } },
      ),
    },
  },
};

export function managedLoginAssets() {
  // Cognito's SVG allowlist omits ARIA attributes; leave the web favicon unchanged.
  const favicon = readFileSync(
    new URL('../../apps/web/public/favicon.svg', import.meta.url),
    'utf8',
  ).replace(/\s(?:role|aria-label)="[^"]*"/gu, '');
  const robot = favicon.replace(/<svg\b[^>]*>/u, '').replace(/<\/svg>\s*$/u, '');
  const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80" viewBox="0 0 320 80">
    <title>Robot Runner: A puro prompt</title>
    <g transform="translate(4 16) scale(.75)">${robot}</g>
    <text x="66" y="28" fill="#d8b36a" font-family="Arial, sans-serif" font-size="10" font-weight="700" letter-spacing="1.5">A PURO PROMPT</text>
    <text x="66" y="59" fill="#f7f1e1" font-family="Georgia, serif" font-size="34" letter-spacing="-1.5">Robot Runner</text>
  </svg>`;
  const background = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
    <defs><radialGradient id="glow" cx="22%" cy="0%" r="70%"><stop stop-color="#273022"/><stop offset="1" stop-color="#14130f"/></radialGradient></defs>
    <rect width="1920" height="1080" fill="url(#glow)"/>
  </svg>`;
  return [
    {
      category: 'FORM_LOGO',
      extension: 'SVG',
      colorMode: 'DARK',
      bytes: Buffer.from(logo).toString('base64'),
    },
    {
      category: 'PAGE_BACKGROUND',
      extension: 'SVG',
      colorMode: 'DARK',
      bytes: Buffer.from(background).toString('base64'),
    },
    {
      category: 'FAVICON_SVG',
      extension: 'SVG',
      colorMode: 'DARK',
      bytes: Buffer.from(favicon).toString('base64'),
    },
  ];
}
