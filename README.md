# Price Watch

Application Shopify interne de veille tarifaire pour Besançon Archerie.

## Fonctionnalités V1

- synchronisation manuelle du catalogue Shopify, avec une ligne par produit ;
- mise à jour par webhooks produits ;
- gestion des concurrents, de leur statut de conformité et de leur `robots.txt` ;
- correspondances manuelles entre produits Shopify et URLs concurrentes ;
- extraction JSON-LD, microdonnées/meta, sélecteurs CSS et fallback prudent ;
- rendu Chromium optionnel pour les pages dynamiques ;
- journal de chaque tentative de relevé ;
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

La migration `20260703110000_product_centric_refactor` convertit l’ancien
modèle centré sur les variantes vers un modèle centré sur les produits. Elle
conserve la première variante de chaque produit comme prix de référence et
rattache les correspondances existantes au produit.

Pour chaque produit, l’application conserve notamment :

- l’identifiant Shopify, le titre, la marque, le handle et le statut ;
- l’image principale ;
- l’identifiant, le titre et le SKU de la première variante ;
- son prix et sa devise ;
- les dates de création et de mise à jour Shopify.

La seed initialise :

- Star Archerie ;
- Normandie Archerie ;
- Bourgogne Archerie ;
- Donut Archery ;
- Europe Archery ;
- Erhart Sports.

Tous les concurrents sont créés avec le statut juridique `PENDING`. Aucun
relevé n’est possible avant le passage manuel à `APPROVED`.

Lors de l’ajout d’un concurrent, l’application récupère et conserve son
`robots.txt`. Son contenu et l’état détecté sont consultables dans la fiche du
concurrent. Un chemin interdit bloque les relevés automatiques, sauf si une
dérogation a été explicitement confirmée dans l’interface.

## Correspondances et benchmark

Le sélecteur Shopify permet de choisir un **produit**, et non une variante.
Chaque correspondance contient uniquement le produit, le concurrent, l’URL et
son statut :

- `À vérifier` ;
- `Validé` ;
- `Rejeté`.

Le bouton de recherche automatique consulte les sitemaps publics des
concurrents actifs et approuvés. Le SKU est prioritaire, puis la marque et le
titre servent à classer les URLs candidates. Toutes les propositions restent
au statut `À vérifier` et doivent être contrôlées humainement. Aucun moteur de
recherche externe n’est scrapé.

Chaque concurrent peut définir une `URL de recherche publique` contenant le
marqueur `{query}`. Des modèles sont préconfigurés pour Star Archerie,
Normandie Archerie, Bourgogne Archerie, Donut Archery et Erhart Sports. Si un
site renvoie une protection technique, comme le challenge Cloudflare d’Europe
Archery, l’application signale explicitement le blocage et n’essaie pas de le
contourner.

Seules les correspondances validées apparaissent dans le benchmark. Les
produits sans correspondance validée ne sont pas affichés.

Le tableau de bord présente le prix Besançon, le meilleur prix concurrent, le
concurrent le moins cher, les écarts en euros et en pourcentage, ainsi que le
nombre de concurrents moins chers. Les statuts sont calculés ainsi :

- `Top prix` : aucun concurrent moins cher ;
- `Compétitif` : écart inférieur à 2 % ;
- `À surveiller` : écart de 2 à 5 % ;
- `À corriger` : écart supérieur à 5 %.

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
- effectue au maximum une requête concurrente à la fois ;
- attend un délai aléatoire de 2 à 5 secondes entre deux requêtes ;
- utilise un user-agent identifiable contenant `SCRAPER_CONTACT_EMAIL` ;
- ne relève pas automatiquement deux fois la même URL avant la fréquence
  configurée, 5 jours par défaut ;
- désactive automatiquement un concurrent après une réponse `403` ou `429` ;
- ne contourne jamais CAPTCHA, connexion ou protection anti-bot.

Un test manuel conserve une fenêtre de sécurité de 24 heures et indique les
URLs ignorées. Le mode forcé est réservé au développement et est refusé en
production.

Les pages HTML ne sont pas conservées. Le journal enregistre pour chaque
tentative la date, le concurrent, l’URL, le statut HTTP, la durée, le succès et
l’erreur éventuelle. En cas de succès, le prix, la devise, la disponibilité, la
méthode d’extraction et une empreinte SHA-256 sont également stockés.

## Cron Coolify

La page **Automatisation** permet d’activer ou désactiver la collecte, de régler
une fréquence de 1 à 30 jours, de consulter la prochaine échéance et
l’historique des lancements.

Configurer dans Coolify une tâche planifiée qui exécute chaque heure :

```cron
0 * * * *
```

avec la commande :

```bash
npm run scrape
```

Cette vérification horaire effectue seulement une requête en base. Le crawl
n’est lancé que lorsque `nextRunAt` est atteint. La fréquence peut ainsi être
modifiée depuis Shopify sans reconfigurer Coolify.

### Route HTTP

Effectuer un `POST` vers :

```text
https://zixsw7530bseuso30tid1xpp.217.160.121.83.sslip.io/api/cron/scrape
```

avec l’en-tête :

```text
Authorization: Bearer <CRON_SECRET>
```

Exemple :

```bash
curl --fail --request POST \
  --header "Authorization: Bearer $CRON_SECRET" \
  https://zixsw7530bseuso30tid1xpp.217.160.121.83.sslip.io/api/cron/scrape
```

La route applique elle aussi les réglages de la page Automatisation. Un verrou
PostgreSQL empêche deux exécutions simultanées.

### Synchronisation catalogue sans navigateur

Une session Shopify hors ligne étant créée à l’installation, le catalogue peut
être synchronisé côté serveur :

```bash
curl --fail --request POST \
  --header "Authorization: Bearer $CRON_SECRET" \
  https://zixsw7530bseuso30tid1xpp.217.160.121.83.sslip.io/api/cron/sync-products
```

Cette route détecte automatiquement la boutique installée et reste protégée par
le même secret que le cron de relevé.

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
