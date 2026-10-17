# City Drive — Marseille

Jeu de conduite three.js dans Marseille (données OpenStreetMap) : Ferrari, manette Xbox, vol (RB), jour/nuit, mouettes, piétons variés.

## Lancer

```sh
python3 -m http.server 8000
```

Puis ouvrir http://localhost:8000/marseille.html

## Données

Les tuiles (`tiles/`) sont générées par `tools/build-tiles.mjs` et `tools/build-heights.mjs` à partir des extraits OSM bruts (`osm-raw/`, non versionnés car trop volumineux).

Carte © contributeurs OpenStreetMap (ODbL).
