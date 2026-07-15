module.exports = {
  packagerConfig: {
    name: 'Shell',
    asar: true,
    extraResource: ['browser/ui'],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32'],
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-webpack',
      config: {
        mainConfig: './webpack.main.config.js',
        renderer: {
          config: './webpack.renderer.config.js',
          entryPoints: [
            {
              name: 'browser',
              preload: {
                js: './preload.ts',
              },
            },
          ],
        },
        devServer: {
          client: {
            overlay: false,
            // The preload is injected into every frame of the session, including
            // remote HTTPS pages. The default HMR socket URL uses the dev server
            // host (0.0.0.0), which HTTPS pages reject as mixed content and the
            // resulting SecurityError aborts the whole preload script. localhost
            // is exempt from mixed content checks, so use it explicitly.
            webSocketURL: {
              hostname: 'localhost',
            },
          },
        },
      },
    },
  ].filter(Boolean),
}
