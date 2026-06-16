/**
 * GENERATED FILE — do not edit by hand.
 * Source: specimen-layout.json + component-catalog.json → npm run build in @sindustries/design-tokens
 */

export const SPECIMEN_PAGES = [
  {
    "id": "tokens",
    "penFrameId": "siSpecRoot",
    "title": "Sindustries design system",
    "penTitle": "Pencil token specimen",
    "eyebrow": "DESIGN TOKENS",
    "intro": "Generated from tokens.json. Compare with /design-system and product apps.",
    "pack": null,
    "layout": {
      "x": 32,
      "y": 32,
      "width": 960
    },
    "sections": [
      {
        "id": "color",
        "type": "colorSwatches",
        "title": "Color"
      },
      {
        "id": "colorLabels",
        "type": "labelSwatches",
        "title": "Color labels"
      },
      {
        "id": "typography",
        "type": "typography",
        "title": "Typography"
      },
      {
        "id": "space",
        "type": "space",
        "title": "Space"
      },
      {
        "id": "radius",
        "type": "radius",
        "title": "Radius"
      }
    ]
  },
  {
    "id": "pulse-react",
    "penFrameId": "siReactSpecPulse",
    "title": "Pulse / React",
    "penTitle": "Pulse React specimen",
    "eyebrow": "REACT · PULSE",
    "intro": "Live components from @sindustries/ui/react with data-si-pack=\"pulse\". Code paths sit beside each section where linked.",
    "pack": "pulse",
    "layout": {
      "x": 1024,
      "y": 32,
      "width": 960
    },
    "sections": [
      {
        "id": "surfaces",
        "type": "surfaceStack",
        "title": "Surfaces"
      },
      {
        "id": "components",
        "type": "componentGroups",
        "title": "Components",
        "groupPack": "pulse"
      },
      {
        "id": "catalog",
        "type": "codeCatalog",
        "title": "Code catalog",
        "groupPack": "pulse"
      }
    ]
  },
  {
    "id": "brand-react",
    "penFrameId": "siReactSpecBrand",
    "title": "Brand / React",
    "penTitle": "Brand React specimen",
    "eyebrow": "REACT · BRAND",
    "intro": "Live components from @sindustries/ui/react with data-si-pack=\"brand\" — the editorial kit used by the brand site. Pill CTAs, translucent surfaces, soft glows.",
    "pack": "brand",
    "theme": "light",
    "layout": {
      "x": 2016,
      "y": 32,
      "width": 960
    },
    "sections": [
      {
        "id": "components",
        "type": "componentGroups",
        "title": "Brand components",
        "groupPack": "brand"
      },
      {
        "id": "catalog",
        "type": "codeCatalog",
        "title": "Code catalog",
        "groupPack": "brand"
      }
    ]
  }
];
