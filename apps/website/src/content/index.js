import Ajv from 'ajv';
import experiments from './experiments.json';
import systems from './systems.json';
import releases from './releases.json';
import stacks from './stacks.json';

const storyModules = import.meta.glob('./stories/*.json', { eager: true, import: 'default' });

const ajv = new Ajv({ allErrors: true });

const linkSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: ['label', 'url'],
    properties: {
      label: { type: 'string' },
      url: { type: 'string' }
    },
    additionalProperties: true
  }
};

const experimentSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: [
      'title',
      'slug',
      'status',
      'summary',
      'why',
      'successCriteria',
      'currentLearning',
      'startedAt',
      'updatedAt',
      'links',
      'image',
      'visibility'
    ],
    properties: {
      title: { type: 'string' },
      slug: { type: 'string' },
      status: { enum: ['idea', 'active', 'paused', 'shipped', 'killed'] },
      summary: { type: 'string' },
      why: { type: 'string' },
      successCriteria: { type: 'string' },
      currentLearning: {
        type: 'array',
        items: { type: 'string' }
      },
      startedAt: { type: 'string' },
      updatedAt: { type: 'string' },
      links: linkSchema,
      image: { type: 'string' },
      visibility: { enum: ['draft', 'review', 'published', 'archived'] }
    },
    additionalProperties: true
  }
};

const systemSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: [
      'title',
      'slug',
      'status',
      'summary',
      'problem',
      'howItWorks',
      'proof',
      'updatedAt',
      'links',
      'image',
      'visibility'
    ],
    properties: {
      title: { type: 'string' },
      slug: { type: 'string' },
      status: { enum: ['designing', 'building', 'operating', 'retired'] },
      summary: { type: 'string' },
      problem: { type: 'string' },
      howItWorks: { type: 'string' },
      proof: { type: 'string' },
      updatedAt: { type: 'string' },
      links: linkSchema,
      image: { type: 'string' },
      visibility: { enum: ['draft', 'review', 'published', 'archived'] }
    },
    additionalProperties: true
  }
};

const releaseSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: ['title', 'slug', 'releasedAt', 'summary', 'type', 'links', 'evidence', 'visibility'],
    properties: {
      title: { type: 'string' },
      slug: { type: 'string' },
      releasedAt: { type: 'string' },
      summary: { type: 'string' },
      type: { enum: ['product', 'system', 'content', 'experiment', 'infrastructure'] },
      links: linkSchema,
      evidence: { type: 'string' },
      visibility: { enum: ['draft', 'review', 'published', 'archived'] }
    },
    additionalProperties: true
  }
};

const stackSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: ['name', 'category', 'summary', 'whyWeUseIt', 'status', 'links', 'updatedAt', 'visibility'],
    properties: {
      name: { type: 'string' },
      category: { enum: ['agent', 'model', 'infra', 'app', 'workflow', 'design'] },
      summary: { type: 'string' },
      whyWeUseIt: { type: 'string' },
      status: { enum: ['core', 'testing', 'retired'] },
      links: linkSchema,
      updatedAt: { type: 'string' },
      visibility: { enum: ['draft', 'review', 'published', 'archived'] }
    },
    additionalProperties: true
  }
};

function assertValidContent(name, schema, data) {
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    throw new Error(`${name} content failed schema validation: ${ajv.errorsText(validate.errors)}`);
  }
}

assertValidContent('experiments', experimentSchema, experiments);
assertValidContent('systems', systemSchema, systems);
assertValidContent('releases', releaseSchema, releases);
assertValidContent('stacks', stackSchema, stacks);

export const experimentsContent = experiments;
export const systemsContent = systems;
export const releasesContent = releases;
export const stacksContent = stacks;
export const storiesContent = Object.values(storyModules).sort((left, right) => {
  const leftOrder = Number.isFinite(left.displayOrder) ? left.displayOrder : Number.MAX_SAFE_INTEGER;
  const rightOrder = Number.isFinite(right.displayOrder) ? right.displayOrder : Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return left.slug.localeCompare(right.slug);
});
