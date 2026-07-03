# Price Watch

Application Shopify interne de veille tarifaire pour Besançon Archerie.

## Fonctionnalités V1

- synchronisation manuelle du catalogue Shopify et de ses variantes ;
- mise à jour par webhooks produits ;
- gestion des concurrents et de leur statut de conformité ;
- correspondances manuelles entre variantes Shopify et URLs concurrentes ;
- extraction JSON-LD, microdonnées/meta, sélecteurs CSS et fallback prudent ;
- rendu Chromium optionnel pour les pages dynamiques ;
- historique des prix et erreurs ;
- tableau de bord des écarts TTC hors livraison ;
- export CSV compatible Excel français ;
- lancement manuel, par route cron sécurisée ou par commande ;
- protection SSRF, limites de taille, délais et arrêt sur blocage.

## Stack

- Shopify CLI et template React Router TypeScript ;
- React et composants Shopify App Home ;
- Prisma et PostgreSQL ;
- Vitest ;
- Docker et Coolify ;
- GitHub Actions.

## Prérequis

- Node.js 22 ;
- npm ;
- Shopify CLI ;
- Docker pour PostgreSQL local ;
- une boutique de développement Shopify pour les essais.

## Installation locale

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run setup
npm run seed
shopify app dev
```

Renseigner dans `.env` les valeurs fournies par Shopify CLI. Ne jamais commiter
ce fichier.

### Variables d’environnement

| Variable                   | Obligatoire | Description                           |
| -------------------------- | ----------- | ------------------------------------- |
| `SHOPIFY_API_KEY`          | oui         | Clé de l’application Shopify          |
| `SHOPIFY_API_SECRET`       | oui         | Secret de l’application Shopify       |
| `SCOPES`                   | oui         | `read_products`                       |
| `SHOPIFY_APP_URL`          | oui         | URL HTTPS publique de l’application   |
| `DATABASE_URL`             | oui         | Connexion PostgreSQL                  |
| `CRON_SECRET`              | oui         | Secret long envoyé en Bearer au cron  |
| `SCRAPER_CONTACT_EMAIL`    | oui         | Contact inclus dans le user-agent     |
| `CHROMIUM_EXECUTABLE_PATH` | navigateur  | Chemin de Chromium                    |
| `SHOP_CUSTOM_DOMAIN`       | non         | Domaine Shopify personnalisé autorisé |
| `PORT`                     | non         | Port HTTP, `3000` par défaut          |

## Configuration Shopify

1. Créer/lier l’application avec Shopify CLI.
2. Choisir une **distribution personnalisée** pour la boutique Besançon
   Archerie.
3. Conserver uniquement le scope `read_products`.
4. Déployer la configuration :

```bash
shopify app deploy
```

La configuration enregistre les webhooks suivants :

- `app/uninstalled`
- `app/scopes_update`
- `products/create`
- `products/update`
- `products/delete`

## Base de données

Créer et appliquer une migration :

```bash
npx prisma migrate dev
```

En production :

```bash
npx prisma migrate deploy
```

Le conteneur exécute automatiquement `prisma migrate deploy` avant de démarrer.

La seed initialise :

- Star Archerie ;
- Normandie Archerie ;
- Bourgogne Archerie ;
- Donut Archery ;
- Europe Archery ;
- Erhart Sports.

Tous les concurrents sont créés avec le statut juridique `PENDING`. Aucun
relevé n’est possible avant le passage manuel à `APPROVED`.

## Collecte des prix

Ordre d’extraction :

1. `Product`/`Offer` JSON-LD ;
2. microdonnées Schema.org et meta tags ;
3. sélecteur CSS propre au concurrent ;
4. fallback uniquement lorsqu’un prix unique en euros est détecté.

Le mode `BROWSER` utilise Chromium pour les variantes ou prix calculés en
JavaScript. Il doit rester réservé aux domaines validés.

L’application :

- refuse les domaines différents de celui du concurrent ;
- refuse les IP privées, localhost, identifiants URL et ports inhabituels ;
- revalide chaque redirection ;
- limite les réponses à 2 Mo ;
- impose un timeout ;
- effectue les relevés séquentiellement par concurrent ;
- désactive automatiquement un concurrent après une réponse `403` ou `429` ;
- ne contourne jamais CAPTCHA, connexion ou protection anti-bot.

Les pages HTML ne sont pas conservées. Seuls le prix, la devise, la
disponibilité, la méthode, les erreurs et une empreinte SHA-256 sont stockés.

## Cron Coolify

### Route HTTP

Effectuer un `POST` vers :

```text
https://price-watch.example.com/api/cron/scrape
```

avec l’en-tête :

```text
Authorization: Bearer <CRON_SECRET>
```

Exemple :

```bash
curl --fail --request POST \
  --header "Authorization: Bearer $CRON_SECRET" \
  https://price-watch.example.com/api/cron/scrape
```

Un verrou PostgreSQL empêche deux exécutions simultanées.

### Commande

```bash
npm run scrape
```

## Déploiement Coolify

1. Créer une base PostgreSQL dans Coolify.
2. Créer une application depuis le repository GitHub.
3. Sélectionner le build Dockerfile.
4. Configurer toutes les variables d’environnement.
5. Exposer le port `3000`.
6. Utiliser `/health` comme healthcheck.
7. Associer le domaine HTTPS définitif.
8. Reporter ce domaine dans `SHOPIFY_APP_URL` et la configuration Shopify.

Le Dockerfile installe Chromium et exécute l’application avec un utilisateur
non privilégié.

## GitHub Actions

La CI exécute :

1. installation reproductible ;
2. génération et validation Prisma ;
3. lint ;
4. typecheck ;
5. tests ;
6. build.

Pour déclencher Coolify après une réussite sur `main` :

- créer le secret GitHub `COOLIFY_DEPLOY_WEBHOOK` avec l’URL complète du
  webhook Coolify ;
- créer la variable GitHub `COOLIFY_DEPLOY_ENABLED=true`.

Ne pas activer simultanément l’auto-déploiement Coolify sur push, afin d’éviter
deux déploiements pour le même commit.

## Tests et vérifications

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Les tests d’extraction utilisent des fixtures locales et ne contactent aucun
site concurrent.

## Périmètre volontairement exclu de la V1

- découverte automatique des concurrents ;
- matching automatique sans validation humaine ;
- modification automatique des prix Shopify ;
- contournement des protections techniques ;
- collecte de pages privées ou authentifiées ;
- comparaison des frais de livraison ;
- multi-boutique et facturation Shopify.
