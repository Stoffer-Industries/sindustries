---
name: sindustries-hero-image
description: Generate ultra-premium cinematic hero images for Sindustries brand. Use when creating hero images, product photography, or marketing visuals for sindustries.co.nz. Uses hardcoded openai/gpt-image-2 model for maximum quality.
---

# Sindustries Hero Image

Generate cinematic, ultra-premium hero images using the Sindustries brand prompt template.

## Model

**openai/gpt-image-2** — hardcoded. Best quality available, 2K max, up to 5 reference images. Never use 4K — outputs exceed the 6MB limit.

## 3 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HERO_ENV` | `brutalist concrete building courtyard` | Environment/scene |
| `HERO_OBJECT` | _(required)_ | Primary object or product |
| `HERO_SUPPORTING` | _(optional)_ | 1–3 supporting objects |

## Workflow

1. Run the generator script with `--condensed` flag (avoids timeout on complex prompts):
   ```bash
   python3 skills/content/sindustries-hero-image/scripts/generate_hero.py \
     --env "brutalist concrete building courtyard" \
     --object "matador seg28 travel pack" \
     --supporting "loom tea towel" "timemore scale" \
     --condensed
   ```
2. The script outputs the full prompt and saves it to `brain/posts/heroes/{timestamp}-{object}.json`
3. Call `image_generate` with model `openai/gpt-image-2`, aspect ratio `16:9`, resolution `2K`, size `2048x1152`. Never use 4K.
4. Save the output PNG to `brain/posts/heroes/`

**Important:** Always use `--condensed` flag. The full brand prompt template causes timeouts with gpt-image-2.

## Output Location

`~/.openclaw/workspace/brain/posts/heroes/`

## Script

See `scripts/generate_hero.py` (path is relative to this skill directory). The `--condensed` flag switches to a shorter prompt that reliably generates without timeout.
