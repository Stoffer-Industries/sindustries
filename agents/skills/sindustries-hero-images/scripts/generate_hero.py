#!/usr/bin/env python3
"""
Sindustries Hero Image Generator

Generates ultra-premium cinematic hero images using the Sindustries brand prompt template.
Hardcoded to openai/gpt-image-2 for maximum quality.

Usage:
    python3 generate_hero.py --env "brutalist concrete building courtyard" --object "matador seg28 travel pack" --supporting "loom tea towel" "timemore scale"

Environment vars (fallback):
    HERO_ENV     - default: "brutalist concrete building courtyard"
    HERO_OBJECT  - required, the primary focus object/product
    HERO_SUPPORTING - optional, 1-3 supporting objects (space-separated)
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

HERO_ENV_DEFAULT = "brutalist concrete building courtyard"

BRAND_PROMPT_TEMPLATE = """Create a cinematic, ultra-premium hero image for Sindustries.

Brand tone:
- curated life upgrades
- sharp, intentional, intelligent
- no fluff, only the good stuff
- modern industrial minimalism
- Japanese utility aesthetic
- subtle street/skate influence
- calm confidence, not loud luxury
- feels rare, niche, hard-to-find

Visual style:
- soft directional lighting
- tactile materials
- deep shadows with controlled highlights
- matte surfaces over glossy
- realistic imperfections
- slightly moody atmosphere
- highly detailed textures
- editorial product photography
- subtle film grain
- restrained composition
- negative space for website text overlay

Environment:
{environment}

Primary object/focus:
{primary_object}

Supporting objects:
{supporting_objects}

Material palette:
- brushed aluminum
- matte black
- bone white
- smoked glass
- stainless steel
- dark walnut
- concrete
- textured paper
- woven fabric
- soft rubber

Color palette:
- off-white
- charcoal
- muted graphite
- subtle deep teal accents
- restrained warm neutrals
- avoid bright saturated colors

Composition:
- asymmetrical balance
- object slightly off-center
- layered depth
- foreground texture
- atmospheric background blur
- clean framing
- feels designed, not staged

Avoid:
- generic startup aesthetics
- RGB gaming vibes
- neon cyberpunk
- excessive glow
- fake AI smoothness
- overly polished luxury
- busy compositions
- stock-photo energy
- floating holograms
- obvious tech clichés

Mood keywords:
intentional, relevant, sharper every day, engineered calm, modern ritual, utility as identity

Output:
high-resolution, photorealistic, cinematic lighting, 16:9 hero composition"""


CONDENSED_PROMPT_TEMPLATE = """Cinematic ultra-premium 16:9 hero image for Sindustries brand.

Modern industrial minimalism, Japanese utility aesthetic, subtle skate influence. Calm confidence, rare and niche feel.

Scene: {environment}
Subject: {primary_object}
Supporting: {supporting_objects}

Soft directional lighting, tactile materials, deep shadows with controlled highlights. Matte surfaces. Moody atmosphere, film grain, detailed textures. Editorial product photography style.

Palette: off-white, charcoal, muted graphite, deep teal accents. Restrained warm neutrals.

Asymmetrical composition, object slightly off-center, layered depth, foreground texture, atmospheric blur, negative space for text overlay.

Avoid: startup aesthetics, RGB gaming, neon cyberpunk, fake AI smoothness, busy compositions, stock-photo energy.

Photorealistic, high-resolution, cinematic lighting."""

def build_prompt(env: str, primary_object: str, supporting: list[str], condensed: bool = False) -> str:
    supporting_str = "none" if not supporting else ", ".join(supporting)
    if condensed:
        return CONDENSED_PROMPT_TEMPLATE.format(
            environment=env,
            primary_object=primary_object,
            supporting_objects=supporting_str,
        )
    supporting_str = "\n".join(f"- {obj}" for obj in supporting) if supporting else "- none"
    return BRAND_PROMPT_TEMPLATE.format(
        environment=env,
        primary_object=primary_object,
        supporting_objects=supporting_str,
    )


def main():
    parser = argparse.ArgumentParser(description="Generate Sindustries hero images")
    parser.add_argument("--env", default=os.environ.get("HERO_ENV", HERO_ENV_DEFAULT),
                        help=f"Environment scene (default: {HERO_ENV_DEFAULT})")
    parser.add_argument("--object", default=os.environ.get("HERO_OBJECT", ""),
                        help="Primary object/product to feature (required)")
    parser.add_argument("--supporting", nargs="*",
                        help="1-3 supporting objects")
    parser.add_argument("--output-dir", default="~/.openclaw/workspace/brain/posts/heroes",
                        help="Output directory")
    parser.add_argument("--condensed", action="store_true",
                        help="Use shorter prompt (avoids timeout on complex prompts)")
    args = parser.parse_args()

    if not args.object:
        print("ERROR: --object is required (or set HERO_OBJECT env var)", file=sys.stderr)
        sys.exit(1)

    supporting = args.supporting or os.environ.get("HERO_SUPPORTING", "").split() or []
    supporting = [s for s in supporting if s]

    prompt = build_prompt(args.env, args.object, supporting, condensed=args.condensed)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    safe_object = args.object.lower().replace(" ", "-")[:40]
    filename = f"{timestamp}-{safe_object}.png"
    output_dir = Path(output_path := os.path.expanduser(f"{args.output_dir}/{filename}")).parent
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"=== PROMPT ===")
    print(prompt)
    print(f"\n=== CALLING IMAGE_GENERATE ===")
    print(f"Model: openai/gpt-image-2")
    print(f"Output: {output_path}")
    print(f"Aspect: 16:9 | Size: 3840x2160")

    tool_call = {
        "tool": "image_generate",
        "params": {
            "prompt": prompt,
            "model": "openai/gpt-image-2",
            "aspectRatio": "16:9",
            "size": "3840x2160",
            "outputFormat": "png",
            "filename": filename,
        }
    }
    print(f"\n=== TOOL CALL ===")
    print(json.dumps(tool_call, indent=2))

    # Save metadata
    with open(f"{output_path}.txt", "w") as f:
        f.write(prompt)
    with open(f"{output_path}.json", "w") as f:
        json.dump({
            "prompt": prompt,
            "env": args.env,
            "object": args.object,
            "supporting": supporting,
            "model": "openai/gpt-image-2",
            "size": "3840x2160",
        }, f, indent=2)

    print(f"\nSaved prompt metadata to {output_path}.txt and {output_path}.json")
    print(f"\nRun the tool call above to generate the image.")


if __name__ == "__main__":
    main()