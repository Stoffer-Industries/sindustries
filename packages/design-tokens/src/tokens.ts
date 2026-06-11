/**
 * GENERATED FILE — do not edit by hand unless you know what you are doing.
 * Source of truth: tokens.json → run `npm run build` in this package (scripts/build-tokens.mjs).
 */

export const tokens = {
  "core": {
    "color": {
      "bone": {
        "50": "#f4f2ee",
        "100": "#f4f1ea",
        "150": "#f5f2e8",
        "200": "#edebe6",
        "250": "#e8e4dc",
        "300": "#e4e0d8",
        "400": "#d5d3cd"
      },
      "graphite": {
        "400": "#9CA3AF",
        "500": "#8f969e",
        "600": "#5C6670",
        "700": "#3D444D",
        "800": "#2b2f34"
      },
      "ink": {
        "800": "#1a1f24",
        "900": "#161a1e",
        "950": "#111213"
      },
      "neutral": {
        "0": "#FFFFFF",
        "200": "#dddddd",
        "300": "#d3d3d3"
      },
      "paper": {
        "200": "#ece3cc"
      },
      "accent": {
        "200": "#ff8ab4",
        "500": "#ff3e8a"
      },
      "brand": {
        "200": "#ffe891",
        "500": "#ffc935"
      },
      "sage": {
        "500": "#7a8b7c"
      },
      "danger": {
        "500": "#ff5252"
      },
      "info": {
        "200": "#9ee9ff",
        "500": "#00d4ff"
      },
      "success": {
        "200": "#9ee9b0",
        "500": "#31c76a"
      },
      "label": {
        "blue": "#60a5fa",
        "orange": "#f59e0b",
        "purple": "#a78bfa"
      },
      "glass": {
        "light": "rgba(255, 255, 255, 0.72)",
        "dark": "rgba(43, 47, 52, 0.68)"
      },
      "alpha": {
        "borderSubtleLight": "rgba(0, 0, 0, 0.06)",
        "borderSubtleDark": "rgba(143, 150, 158, 0.18)"
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
        "bgCanvas": "#f4f1ea",
        "bgSectionHeader": "#e8e4dc",
        "bgSection": "#f4f2ee",
        "bgSurface": "#f5f2e8",
        "bgGlass": "rgba(255, 255, 255, 0.72)",
        "textPrimary": "#2b2f34",
        "textSecondary": "#3D444D",
        "textTertiary": "#7a8b7c",
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
        "bgField": "#edebe6",
        "bgPaginationActive": "#e4e0d8",
        "bgImagePlaceholder": "#edebe6",
        "onDangerFg": "#FFFFFF",
        "boneUi": "#edebe6"
      },
      "dark": {
        "ctaPrimary": "#ffc935",
        "ctaPrimaryText": "#111213",
        "ctaSecondary": "#7a8b7c",
        "bgCanvas": "#111213",
        "bgSectionHeader": "#161a1e",
        "bgSection": "#2b2f34",
        "bgSurface": "#1a1f24",
        "bgGlass": "rgba(43, 47, 52, 0.68)",
        "textPrimary": "#ece3cc",
        "textSecondary": "#8f969e",
        "textTertiary": "#ffc935",
        "textMuted": "#5C6670",
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
        "bgField": "#161a1e",
        "bgPaginationActive": "#111213",
        "bgImagePlaceholder": "#111213",
        "onDangerFg": "#f4f1ea",
        "boneUi": "#f4f1ea"
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
    },
    "surfaceStack": [
      "bgCanvas",
      "bgSection",
      "bgSurface"
    ]
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
  bgSectionHeader: dark.bgSectionHeader,
  bgSection: dark.bgSection,
  bgSurface: dark.bgSurface,
  bgGlass: dark.bgGlass,
  textPrimary: dark.textPrimary,
  textSecondary: dark.textSecondary,
  textTertiary: dark.textTertiary,
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
  boneUi: dark.boneUi,
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
  bgSectionHeader: light.bgSectionHeader,
  bgSection: light.bgSection,
  bgSurface: light.bgSurface,
  bgGlass: light.bgGlass,
  textPrimary: light.textPrimary,
  textSecondary: light.textSecondary,
  textTertiary: light.textTertiary,
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
  boneUi: light.boneUi,
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

/** Surface stack color keys (see tokens.semantic.surfaceStack). */
export const surfaceStack = tokens.semantic.surfaceStack;

/** Resolved surface colors for dark mode. */
export const surfaces = {
  bgCanvas: dark.bgCanvas,
  bgSection: dark.bgSection,
  bgSurface: dark.bgSurface,
} as const;

/** Resolved surface colors for light mode. */
export const surfacesLight = {
  bgCanvas: light.bgCanvas,
  bgSection: light.bgSection,
  bgSurface: light.bgSurface,
} as const;
