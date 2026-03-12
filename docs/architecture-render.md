# Render `architecture.mmd` to SVG

Use either option below. Both commands read `docs/architecture.mmd` and produce `docs/architecture.svg`.

## Option A (Node/NPM)

```bash
npm install --global @mermaid-js/mermaid-cli
mmdc -i docs/architecture.mmd -o docs/architecture.svg -t neutral -b transparent
```

## Option B (Docker, no global install)

```bash
docker run --rm \
  -u "$(id -u):$(id -g)" \
  -v "$PWD":/data \
  minlag/mermaid-cli \
  -i /data/docs/architecture.mmd \
  -o /data/docs/architecture.svg \
  -t neutral \
  -b transparent
```

## Windows PowerShell (Docker)

```powershell
docker run --rm `
  -v "${PWD}:/data" `
  minlag/mermaid-cli `
  -i /data/docs/architecture.mmd `
  -o /data/docs/architecture.svg `
  -t neutral `
  -b transparent
```

## Verify output

```bash
ls -lh docs/architecture.svg
```
