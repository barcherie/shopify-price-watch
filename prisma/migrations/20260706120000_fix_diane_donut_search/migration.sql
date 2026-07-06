UPDATE "Competitor"
SET "searchUrlTemplate" = CASE "domain"
  WHEN 'dianearcherie.com'
    THEN 'https://dianearcherie.com/jolisearch?s={query}'
  WHEN 'donutarchery.com'
    THEN 'https://donutarchery.com/search?type=product%2Cpage%2Carticle&options%5Bprefix%5D=last&q={query}'
  ELSE "searchUrlTemplate"
END
WHERE "domain" IN ('dianearcherie.com', 'donutarchery.com');
