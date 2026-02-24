const path = require('path');
const fs = require('fs');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: true,
    extraResources: [
      { from: path.join(__dirname, '..', 'backend'), to: 'backend' },
    ],
    hooks: {
      packageAfterCopy: async (_config, buildPath) => {
        const backendSrc = path.join(__dirname, '..', 'backend');
        const backendDest = path.join(buildPath, 'resources', 'backend');
        if (fs.existsSync(backendSrc)) {
          fs.mkdirSync(path.join(buildPath, 'resources'), { recursive: true });
          fs.cpSync(backendSrc, backendDest, { recursive: true });
        }
      },
    },
  },
  rebuildConfig: {},
  hooks: {
    postPackage: async (_config, context) => {
      const backendSrc = path.join(__dirname, '..', 'backend');
      const paths = context.outputPaths || [];
      for (const outputPath of paths) {
        if (fs.existsSync(backendSrc)) {
          const resourcesDir = path.join(outputPath, 'resources');
          const backendDest = path.join(resourcesDir, 'backend');
          fs.mkdirSync(resourcesDir, { recursive: true });
          fs.cpSync(backendSrc, backendDest, { recursive: true });
        }
        const pkgPath = path.join(__dirname, 'package.json');
        if (fs.existsSync(pkgPath)) {
          fs.copyFileSync(pkgPath, path.join(outputPath, 'package.json'));
        }
      }
    },
  },
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
        // If you are familiar with Vite configuration, it will look really familiar.
        build: [
          {
            // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
            entry: 'src/main.js',
            config: 'vite.main.config.mjs',
            target: 'main',
          },
          {
            entry: 'src/preload.js',
            config: 'vite.preload.config.mjs',
            target: 'preload',
          },
        ],
        renderer: [
          {
            name: 'main_window',
            config: 'vite.renderer.config.mjs',
          },
        ],
      },
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
