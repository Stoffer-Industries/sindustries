import { describe, expect, it } from 'vitest';
import { defineVariants } from './variants.js';

describe('defineVariants', () => {
  const button = defineVariants({
    base: 'inline-flex items-center justify-center font-extrabold rounded-pill border-2 uppercase transition',
    variants: {
      variant: {
        primary: 'bg-cta-primary border-cta-primary text-cta-primary-text',
        secondary: 'bg-cta-secondary border-cta-secondary text-text-primary',
        ghost: 'bg-bg-field border-transparent text-text-primary'
      },
      size: {
        sm: 'min-h-8 px-3',
        md: 'min-h-10 px-4',
        lg: 'min-h-12 px-5'
      },
      tone: {
        pulse: 'border-bg-canvas rounded-none shadow-hard font-display font-normal',
        display: 'border-bg-canvas rounded-none shadow-hard font-display font-normal'
      }
    },
    defaults: { variant: 'secondary', size: 'md' }
  });

  it('composes base + default variant + default size', () => {
    expect(button({})).toBe(
      'inline-flex items-center justify-center font-extrabold rounded-pill border-2 uppercase transition bg-cta-secondary border-cta-secondary text-text-primary min-h-10 px-4'
    );
  });

  it('overrides a default when the consumer passes the axis', () => {
    expect(button({ variant: 'primary' })).toContain('bg-cta-primary border-cta-primary text-cta-primary-text');
    expect(button({ variant: 'primary' })).not.toContain('bg-cta-secondary');
  });

  it('applies tone only when the consumer passes one', () => {
    expect(button({ tone: 'pulse' })).toContain('border-bg-canvas rounded-none shadow-hard font-display font-normal');
    expect(button({})).not.toContain('shadow-hard');
  });

  it('appends a consumer-supplied class override without dropping the variant classes', () => {
    const result = button({ variant: 'primary', class: 'mt-2' });
    expect(result).toContain('bg-cta-primary');
    expect(result).toContain('mt-2');
  });

  it('accepts className as the override key (JSX convention)', () => {
    const result = button({ className: 'mt-2' });
    expect(result).toContain('mt-2');
  });

  it('accepts arrays in base and variant definitions', () => {
    const def = defineVariants({
      base: ['inline-flex', 'items-center', 'justify-center'],
      variants: { variant: { primary: ['bg-cta-primary', 'text-cta-primary-text'] } }
    });
    expect(def({ variant: 'primary' })).toContain('inline-flex items-center justify-center');
    expect(def({ variant: 'primary' })).toContain('bg-cta-primary text-cta-primary-text');
  });

  it('ignores unknown axes silently (forward-compatible with future axes)', () => {
    const result = button({ variant: 'primary', futureAxis: 'value' });
    expect(result).toContain('bg-cta-primary');
  });
});
