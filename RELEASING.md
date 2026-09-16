# Releasing

## One-time setup

1. Create an account on [npmjs.com](https://www.npmjs.com) if you do not have one.
2. Publish the first version manually (npm requires this for new packages):

   ```sh
   npm login
   npm publish
   ```

3. Set up auth for CI releases. Pick one:
   - **Trusted publishing (recommended).** On npmjs.com, open the package →
     Settings → Trusted Publisher. Select GitHub Actions, repository
     `OCA99/claydo`, workflow `release.yml`. No
     secrets needed; provenance attestations are automatic.
   - **Token.** Create a granular automation token on npmjs.com and save it
     as the `NPM_TOKEN` secret in the GitHub repository settings.

## Every release

```sh
npm version patch   # or minor / major; bumps package.json and tags
git push --follow-tags
```

Then create a GitHub Release from the new tag. The `Release` workflow runs
the full test matrix (library + all examples) and publishes to npm. You can
also trigger it manually from the Actions tab.

`prepublishOnly` runs the typecheck and the build on every publish path, so
a broken build cannot ship.
