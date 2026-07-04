UPDATE "Competitor"
SET "domain" = 'normandie-archerie.com'
WHERE "domain" = 'normandie-archerie.fr'
  AND NOT EXISTS (
    SELECT 1
    FROM "Competitor"
    WHERE "domain" = 'normandie-archerie.com'
  );

UPDATE "Competitor"
SET "searchUrlTemplate" = CASE "domain"
  WHEN 'star-archerie.com'
    THEN 'https://www.star-archerie.com/recherche-resultats.php?search_in_description=1&ac_keywords={query}'
  WHEN 'normandie-archerie.com'
    THEN 'https://normandie-archerie.com/module/iqitsearch/searchiqit?s={query}'
  WHEN 'bourgognearcherie.com'
    THEN 'https://www.bourgognearcherie.com/recherche?s={query}'
  WHEN 'donutarchery.com'
    THEN 'https://donutarchery.com/search?q={query}&type=product'
  WHEN 'erhart-sports.com'
    THEN 'https://www.erhart-sports.com/recherche?s={query}'
  ELSE "searchUrlTemplate"
END
WHERE "domain" IN (
  'star-archerie.com',
  'normandie-archerie.com',
  'bourgognearcherie.com',
  'donutarchery.com',
  'erhart-sports.com'
);
