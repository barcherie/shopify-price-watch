import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const competitors = [
  { name: "Star Archerie", domain: "star-archerie.com" },
  { name: "Normandie Archerie", domain: "normandie-archerie.fr" },
  { name: "Bourgogne Archerie", domain: "bourgognearcherie.com" },
  { name: "Donut Archery", domain: "donutarchery.com" },
  { name: "Europe Archery", domain: "europearchery.com" },
  { name: "Erhart Sports", domain: "erhart-sports.com" },
];

async function main() {
  for (const competitor of competitors) {
    await prisma.competitor.upsert({
      where: { domain: competitor.domain },
      update: { name: competitor.name },
      create: competitor,
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
