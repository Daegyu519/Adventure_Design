const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // 훅 규칙은 기본 설정에도 들어 있지만, 실제 훅 코드가 들어오기 전에 눈에 보이게 고정해 둔다.
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  { ignores: ['dist/*', '.expo/*'] },
]);
