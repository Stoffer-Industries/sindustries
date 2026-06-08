/**
 * GENERATED FILE — do not edit by hand unless you know what you are doing.
 * Source of truth: tokens.json → run `npm run build` in this package (scripts/build-tokens.mjs).
 */

export const tokens = {
  "core": {
    "color": {
      "ink": {
        "900": "#161a1e",
        "950": "#111213"
      },
      "surface": {
        "800": "#2b2f34"
      },
      "slate": {
        "500": "#8f969e"
      },
      "sage": {
        "500": "#7a8b7c"
      },
      "cream": {
        "100": "#f3f1ec",
        "200": "#d5d3cd"
      },
      "paper": {
        "200": "#ece3cc"
      },
      "neutral": {
        "200": "#dddddd",
        "300": "#d3d3d3"
      },
      "brand": {
        "200": "#ffe891",
        "500": "#ffc935"
      },
      "info": {
        "200": "#9ee9ff",
        "500": "#00d4ff"
      },
      "accent": {
        "200": "#ff8ab4",
        "500": "#ff3e8a"
      },
      "success": {
        "500": "#31c76a"
      },
      "danger": {
        "500": "#ff5252"
      }
    },
    "font": {
      "body": "Work Sans",
      "ui": "Inter",
      "display": "Dela Gothic One"
    },
    "space": {
      "1": 4,
      "2": 8,
      "3": 12,
      "4": 16,
      "5": 20,
      "6": 24,
      "7": 28,
      "8": 32,
      "10": 40
    },
    "radius": {
      "xs": 8,
      "sm": 12,
      "md": 18,
      "lg": 22,
      "2xl": 24,
      "xl": 28,
      "pill": 999
    }
  },
  "semantic": {
    "modes": {
      "light": {
        "ctaPrimary": "#7a8b7c",
        "ctaPrimaryText": "#FFFFFF",
        "ctaSecondary": "#ffc935",
        "bgCanvas": "#F4F1EA",
        "bgCanvasAlt": "#E8E4DC",
        "bgSurface": "#FFFFFF",
        "bgGlass": "rgba(255, 255, 255, 0.72)",
        "textPrimary": "#111213",
        "textSecondary": "#3D444D",
        "textMuted": "#5C6670",
        "borderStrong": "#9CA3AF",
        "borderSubtle": "rgba(0, 0, 0, 0.06)",
        "focus": "#00d4ff",
        "statusSuccess": "#31c76a",
        "statusDanger": "#ff5252",
        "statusInfo": "#00d4ff",
        "labelGreen": "#31c76a",
        "labelBlue": "#60a5fa",
        "labelOrange": "#f59e0b",
        "labelPurple": "#a78bfa",
        "labelGray": "#8f969e",
        "bgField": "#FFFFFF",
        "bgPaginationActive": "#E4E0D8",
        "bgImagePlaceholder": "#EDEAE4",
        "onDangerFg": "#FFFFFF",
        "creamUi": "#EDEBE6"
      },
      "dark": {
        "ctaPrimary": "#ffc935",
        "ctaPrimaryText": "#111213",
        "ctaSecondary": "#7a8b7c",
        "bgCanvas": "#111213",
        "bgCanvasAlt": "#161a1e",
        "bgSurface": "#2b2f34",
        "bgGlass": "rgba(43, 47, 52, 0.68)",
        "textPrimary": "#f3f1ec",
        "textSecondary": "#d5d3cd",
        "textMuted": "#8f969e",
        "borderStrong": "#8f969e",
        "borderSubtle": "rgba(143, 150, 158, 0.18)",
        "focus": "#00d4ff",
        "statusSuccess": "#31c76a",
        "statusDanger": "#ff5252",
        "statusInfo": "#00d4ff",
        "labelGreen": "#31c76a",
        "labelBlue": "#60a5fa",
        "labelOrange": "#f59e0b",
        "labelPurple": "#a78bfa",
        "labelGray": "#8f969e",
        "bgField": "#111213",
        "bgPaginationActive": "#111213",
        "bgImagePlaceholder": "#111213",
        "onDangerFg": "#f3f1ec",
        "creamUi": "#f3f1ec"
      }
    },
    "font": {
      "body": "Work Sans",
      "ui": "Inter",
      "display": "Dela Gothic One"
    },
    "shadow": {
      "soft": "0 18px 60px rgb(0 0 0 / 22%)",
      "hard": "4px 4px 0 #111213"
    }
  },
  "platform": {
    "mobile": {
      "tabBar": {
        "height": 62
      },
      "hitTarget": {
        "min": 44
      }
    },
    "web": {
      "content": {
        "maxWidth": 1120
      }
    },
    "pencil": {
      "specimen": {
        "swatchSize": 72
      }
    }
  }
} as const;

export type SemanticMode = (typeof tokens)['semantic']['modes']['light'];

/** Light and dark appearance (canonical source: tokens.json → semantic.modes). */
export const semanticModes = tokens.semantic.modes;

const dark = tokens.semantic.modes.dark;
const light = tokens.semantic.modes.light;

/** Default export shape matches the previous dark-first API (dark mode). */
export const colors = {
  ctaPrimary: dark.ctaPrimary,
  ctaPrimaryText: dark.ctaPrimaryText,
  ctaSecondary: dark.ctaSecondary,
  bgCanvas: dark.bgCanvas,
  bgCanvasAlt: dark.bgCanvasAlt,
  bgSurface: dark.bgSurface,
  bgGlass: dark.bgGlass,
  textPrimary: dark.textPrimary,
  textSecondary: dark.textSecondary,
  textMuted: dark.textMuted,
  borderStrong: dark.borderStrong,
  borderSubtle: dark.borderSubtle,
  focus: dark.focus,
  statusSuccess: dark.statusSuccess,
  statusDanger: dark.statusDanger,
  statusInfo: dark.statusInfo,
  labelGreen: dark.labelGreen,
  labelBlue: dark.labelBlue,
  labelOrange: dark.labelOrange,
  labelPurple: dark.labelPurple,
  labelGray: dark.labelGray,
  bgField: dark.bgField,
  bgPaginationActive: dark.bgPaginationActive,
  bgImagePlaceholder: dark.bgImagePlaceholder,
  onDangerFg: dark.onDangerFg,
  creamUi: dark.creamUi,
  brand: tokens.core.color.brand[500],
  /** Solid ink for labels/icons on brand yellow (not themed canvas). */
  ink950: tokens.core.color.ink[950],
  sage: tokens.core.color.sage[500],
  accentPink: tokens.core.color.accent[500],
  info: dark.statusInfo,
  success: dark.statusSuccess,
  danger: dark.statusDanger,
  labels: {
    green: dark.labelGreen,
    blue: dark.labelBlue,
    orange: dark.labelOrange,
    purple: dark.labelPurple,
    gray: dark.labelGray
  }
} as const;

/** Same keys as `colors`, resolved for light mode. */
export const colorsLight = {
  ctaPrimary: light.ctaPrimary,
  ctaPrimaryText: light.ctaPrimaryText,
  ctaSecondary: light.ctaSecondary,
  bgCanvas: light.bgCanvas,
  bgCanvasAlt: light.bgCanvasAlt,
  bgSurface: light.bgSurface,
  bgGlass: light.bgGlass,
  textPrimary: light.textPrimary,
  textSecondary: light.textSecondary,
  textMuted: light.textMuted,
  borderStrong: light.borderStrong,
  borderSubtle: light.borderSubtle,
  focus: light.focus,
  statusSuccess: light.statusSuccess,
  statusDanger: light.statusDanger,
  statusInfo: light.statusInfo,
  labelGreen: light.labelGreen,
  labelBlue: light.labelBlue,
  labelOrange: light.labelOrange,
  labelPurple: light.labelPurple,
  labelGray: light.labelGray,
  bgField: light.bgField,
  bgPaginationActive: light.bgPaginationActive,
  bgImagePlaceholder: light.bgImagePlaceholder,
  onDangerFg: light.onDangerFg,
  creamUi: light.creamUi,
  brand: tokens.core.color.brand[500],
  /** Solid ink for labels/icons on brand yellow (not themed canvas). */
  ink950: tokens.core.color.ink[950],
  sage: tokens.core.color.sage[500],
  accentPink: tokens.core.color.accent[500],
  info: light.statusInfo,
  success: light.statusSuccess,
  danger: light.statusDanger,
  labels: {
    green: light.labelGreen,
    blue: light.labelBlue,
    orange: light.labelOrange,
    purple: light.labelPurple,
    gray: light.labelGray
  }
} as const;

export const colorsDark = colors;

export const fonts = tokens.semantic.font;
export const space = tokens.core.space;
export const radius = tokens.core.radius;
export const platform = tokens.platform;
