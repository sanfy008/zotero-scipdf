// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default zotero({
  overrides: [
    {
      files: ["**/*.ts"],
      rules: {
        // We disable this rule here because the template
        // contains some unused examples and variables
        "@typescript-eslint/no-unused-vars": "off",
      },
    },
    {
      // The unit tests load modules inside a `vm` context and pass host globals
      // (URL, timers, ...) into that context as plain object properties, which
      // the linter cannot see. They are also CommonJS, so the Node globals are
      // real at runtime.
      files: ["test/**/*.cjs"],
      languageOptions: {
        sourceType: "commonjs",
        globals: {
          URL: "readonly",
          URLSearchParams: "readonly",
          setTimeout: "readonly",
          clearTimeout: "readonly",
          setImmediate: "readonly",
          require: "readonly",
          module: "writable",
          __dirname: "readonly",
        },
      },
      rules: {
        "no-unused-vars": "off",
      },
    },
  ],
});
