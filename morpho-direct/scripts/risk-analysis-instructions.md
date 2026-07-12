# Instructions d'analyse de risque collatéral Morpho — v2 (2026-07-12)

Ce fichier est le protocole d'analyse pour chaque collatéral utilisé sur les marchés Morpho Blue.
Il est lu par les agents d'analyse. Ne pas modifier sans mettre à jour les analyses existantes.

## Contexte

L'utilisateur prête (supply) des stablecoins/ETH/BTC sur des marchés Morpho Blue isolés.
Son risque principal en tant que lender : si le COLLATÉRAL du marché s'effondre (dépeg, hack,
insolvabilité de l'émetteur), les emprunteurs ne remboursent pas, les liquidations échouent,
et le lender subit la bad debt. L'analyse porte donc sur le collatéral en tant qu'actif.

Deux niveaux de note existent :
- **Note collatéral** (ce protocole) : qualité intrinsèque de l'actif — cachée, datée
- **Note marché** (calculée live par l'app, pas par les agents) : note collatéral dégradée par
  les signaux du marché spécifique (oracle non-Chainlink, utilisation > 95 %, LLTV ≥ 94,5 %,
  TVL < 100 K$)

## Framework à appliquer

Lire OBLIGATOIREMENT d'abord : `C:\Users\Arnau\Desktop\vault\02_KNOWLEDGE\frameworks\defi-risk-analysis.md`
(framework Pascal Tallarida : taxonomie des risques, scoring +1/-1, notation A→D, red flags no-go).

## Composantes et checklist de scoring

Chaque composante démarre à B (baseline actif correct). Appliquer +1 (vers A) ou -1 (vers C
puis D) par critère vérifié. Un red flag absolu (framework §6) = D global automatique.

### 1. Asset design
| Critère | +1 | -1 |
|---|---|---|
| Marché primaire | mint/redeem permissionless, instantané | KYC/whitelist, fenêtres, délais > 24 h |
| Liquidité secondaire | depth > 10 % du market cap en 24 h | volume 24 h < 1 % du market cap |
| Complexité du design | wrapper simple 1:1 | empilement (levier, tranches, restaking, synthétique) |
| Ancienneté | > 2 ans | < 1 an |

### 2. Émetteur / protocole
| Critère | +1 | -1 |
|---|---|---|
| Audits | ≥ 2 auditeurs reconnus + bug bounty | 0-1 audit, auditeurs inconnus, vulnérabilités non corrigées |
| TVL / ancienneté émetteur | > 1 Md$ ou > 3 ans sans incident | < 100 M$ ou < 1 an |
| Bad debt historique | jamais | oui, socialisée sur les déposants |
| Gouvernance | DAO + timelock documentés | multisig opaque ou non documenté |

### 3. Dépeg / backing
| Critère | +1 | -1 |
|---|---|---|
| Transparence réserves | preuve on-chain temps réel | attestations manuelles ou rien |
| Historique de peg | jamais > 1 % | dépeg > 5 % déjà constaté |
| Nature du backing | actifs liquides tier-1 | crédit privé, actifs corrélés au token, off-chain invérifiable |

### 4. Counterparty / centralisation
| Critère | +1 | -1 |
|---|---|---|
| Droits admin | contrat immuable | freeze/blacklist/upgrade actifs |
| Dépendance à un acteur unique | non | custodian/gérant/emprunteur unique |
| Régulation | émetteur régulé et coté | entité offshore opaque |

### 5. Sécurité (récente ET historique)
| Critère | +1 | -1 |
|---|---|---|
| Hacks de l'émetteur/actif | jamais depuis création | ≥ 1 (pondérer : montant, ancienneté, remboursement) |
| Incidents 6 derniers mois | aucun | dépeg, pause, exploit, contagion |
| Controverses (gouvernance, légal, fondateurs) | aucune | procès, fraude, scandale de custody, exit de partenaires majeurs |

## Recherches web minimales (par actif)

- "{symbol} {issuer} hack exploit" — TOUTE la période depuis la création, pas seulement récent
- "{symbol} depeg history"
- "{symbol} {issuer} controversy lawsuit SEC" — controverses de gouvernance, légales, réputationnelles
- "{symbol} audit" / page de l'émetteur
- Backing/collatéralisation : docs officielles de l'émetteur
- **Liquidité de sortie (OBLIGATOIRE, quantifié)** : volume 24 h + depth des pools principaux,
  à comparer à la TVL déposée sur Morpho → ratio `TVL Morpho / liquidité sortie 24h`.
  Seuils : < 10 % OK · 10-30 % vigilance · > 30 % red flag (sortie impossible en cas de stress)
- Pour les PT Pendle : analyser le sous-jacent (vérifier l'adresse du contrat SY — pièges
  homonymes déjà rencontrés) + mécanisme PT ([[pt-reusd-10dec2026]] documente le mécanisme)

## Notation

- **A** : tier-1, backing transparent, battle-tested, liquide (allocation max 30-50 %)
- **B** : solide, audité, historique propre, liquidité correcte (15-25 %)
- **C** : récent mais audité, backing plus opaque ou liquidité limitée (5-15 %)
- **D** : expérimental, backing opaque, yield non organique, faible historique (1-5 % ou skip)

Règle du maillon faible : la note globale = la PIRE des composantes, pas la moyenne.
Le modificateur +/- est calculé mécaniquement par le build script (PAS par les agents) :
une seule composante au niveau de la note globale → "+" (faiblesse isolée) ; ≥ 4 composantes
à ce niveau → "-" (faiblesse généralisée).

## Fraîcheur

Les analyses sont datées (`analyzedAt`). L'app grise le badge après 30 jours. Avant tout dépôt
significatif : re-check sécurité (recherche ciblée incidents récents, mise à jour de la date).

## Sorties (2 fichiers par actif)

### 1. Note vault — `C:\Users\Arnau\Desktop\vault\02_KNOWLEDGE\domains\crypto-defi\assets\{slug}.md`

Slug : kebab-case, sans accents. Template frontmatter identique à v1 (type: asset,
risk_grade, risk_analyzed, tags [crypto-defi, asset, morpho-collateral], aliases) avec sections :

1. Description (3 lignes)
2. Mécanique d'émission / redemption
3. Backing / peg
4. **Analyse de risque Morpho** (framework [[defi-risk-analysis]]) — tableau des 5 composantes
   avec justification 1 ligne, note GLOBALE (maillon faible), allocation max, red flags
5. **Dépendances** — émetteur, custodian(s), sous-jacents, contreparties clés (avec wikilinks
   vers les autres notes assets si elles existent : [[usde]], [[cbbtc]]…)
6. **Liquidité de sortie** — TVL Morpho, liquidité 24 h, ratio, verdict
7. **Historique incidents & controverses** — TOUT depuis la création : hacks, dépegs, procès,
   scandales de gouvernance, exits de partenaires. Format `YYYY-MM-DD : description (ampleur,
   résolution)`. Si rien : "Aucun incident connu au YYYY-MM-DD"
8. Chiffres (market cap, TVL Morpho, date)
9. Sources (URLs consultées)

### 2. Fragment JSON — `C:\Users\Arnau\Desktop\Coding\defi-tools\morpho-direct\data\risk-analyses\{slug}.json`

```json
{
  "symbol": "{SYMBOL}",
  "name": "{nom complet}",
  "addresses": { "{chainId}": "{address}" },
  "grade": "A|B|C|D",
  "components": {
    "assetDesign": "X",
    "issuer": "X",
    "depegBacking": "X",
    "counterparty": "X",
    "recentSecurity": "X"
  },
  "redFlags": [],
  "maxAllocation": "15-25%",
  "summary": "3-4 phrases en français : nature de l'actif, forces, faiblesses, verdict lender.",
  "incidents": ["YYYY-MM-DD: incident technique (hack, dépeg, gel)"],
  "controversies": ["YYYY-MM: controverse gouvernance/légale/réputationnelle"],
  "dependencies": {
    "issuer": "{émetteur}",
    "custodians": ["{custodian(s), ou vide}"],
    "underlyings": ["{actifs sous-jacents, ou vide}"],
    "keyCounterparties": ["{contreparties critiques : gérants, emprunteurs uniques, oracles off-chain}"]
  },
  "exitLiquidity": {
    "morphoTvlUsd": 0,
    "dailyLiquidityUsd": 0,
    "ratioPct": 0,
    "note": "1 ligne de contexte (sources des chiffres, 'non trouvé' si introuvable)"
  },
  "analyzedAt": "{YYYY-MM-DD}",
  "vaultNote": "{slug}.md"
}
```

Ne PAS inclure `gradeModifier` — calculé par `scripts/build-risk-index.mjs`.

## Règles

- Analyses en FRANÇAIS, factuelles, sourcées. Zéro invention : si une info est introuvable,
  écrire "non trouvé" et pénaliser le score (opacité = risque).
- Un actif inconnu/introuvable sur le web avec backing opaque = D d'office.
- Ne pas confondre l'actif avec un homonyme : TOUJOURS vérifier l'adresse du contrat
  (3 pièges rencontrés : PRIME=Hastra pas Echelon, reUSD=re.xyz pas Resupply,
  PT-USD3=3Jane pas Reserve).
- Date du jour dans tous les champs de date.

## Passe complémentaire (enrichissement d'une analyse v1 existante)

Quand la mission est d'enrichir une note existante (pas d'en créer une) :
1. Lire la note vault + le fragment JSON existants — NE PAS refaire l'analyse de base
2. Recherches web ciblées : incidents & controverses HISTORIQUES (toute la vie de l'actif,
   requêtes "controversy lawsuit scandal" en plus de "hack depeg") + chiffres de liquidité
   de sortie s'ils manquent
3. Ajouter/mettre à jour dans la note vault : sections Dépendances, Liquidité de sortie,
   Historique incidents & controverses (enrichi) ; frontmatter `updated:` à la date du jour
4. Ajouter dans le JSON : `controversies`, `dependencies`, `exitLiquidity` (conserver tous
   les champs existants)
5. Ne changer la note globale QUE si un fait découvert déclenche un red flag absolu ou
   contredit l'analyse v1 — dans ce cas le signaler explicitement dans la réponse
