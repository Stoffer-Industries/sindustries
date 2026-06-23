// Learn more: https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch the whole monorepo so linked workspace packages
// (@sindustries/ui, @sindustries/design-tokens) are bundled from source.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// The workspace root hoists React 18 (required by the web packages), but
// react-native 0.81 expects React 19 and otherwise resolves the root copy,
// crashing with `Cannot read property 'S' of undefined` (ReactSharedInternals
// is a React 19 internal). Force every `react` import to the app's React 19 so
// react-native's renderer and app code share a single, compatible React.
const appNodeModules = path.resolve(projectRoot, 'node_modules');
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'react' || moduleName.startsWith('react/')) {
    return {
      type: 'sourceFile',
      filePath: require.resolve(moduleName, { paths: [appNodeModules] }),
    };
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
