const fs = require('fs');
const path = require('path');

const assetsDir = path.join(
  __dirname,
  '..',
  'node_modules',
  '@react-navigation',
  'elements',
  'lib',
  'module',
  'assets',
);

const scales = ['1x', '2x', '3x', '4x'];

const ensureBackIconAsset = scale => {
  const generic = path.join(assetsDir, `back-icon@${scale}.png`);
  const android = path.join(assetsDir, `back-icon@${scale}.android.png`);
  const ios = path.join(assetsDir, `back-icon@${scale}.ios.png`);

  if (fs.existsSync(generic)) {
    return;
  }

  const source = fs.existsSync(android)
    ? android
    : fs.existsSync(ios)
    ? ios
    : null;

  if (!source) {
    return;
  }

  fs.copyFileSync(source, generic);
};

if (fs.existsSync(assetsDir)) {
  scales.forEach(ensureBackIconAsset);
}
