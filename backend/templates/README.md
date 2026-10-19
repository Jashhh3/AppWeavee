# Generated React/Vite dependency resources

`react-vite-jsx` is the default. Explicit `typescript` or `tsx` specs use
`react-vite-tsx`, which includes TypeScript and React type dependencies.
Each manifest uses exact direct versions and an npm-generated, complete lockfile.
The generator changes only the package name in the manifest and lockfile.

To update a resource, edit its manifest, then regenerate its lockfile in a clean
temporary directory. From `backend`, for each variant:

```sh
variant=react-vite-jsx # repeat with react-vite-tsx
work=$(mktemp -d)
cp "templates/$variant/package.json" "$work/package.json"
npm install --prefix "$work" --package-lock-only --ignore-scripts --no-audit --no-fund
npm ci --prefix "$work" --ignore-scripts --no-audit --no-fund
cp "$work/package-lock.json" "templates/$variant/package-lock.json"
rm -rf "$work"
```

Run `npm test`, `npm run typecheck`, and `npm run build`. The build copies these
resources to `dist/templates`; the backend Dockerfile includes the source
resources and copy script. Template tests work offline. When updating dependencies,
also generate each variant in a temporary project and run `npm ci` and
`npm run build` there to verify its lockfile and actual production entrypoint.
