import { db, usersTable, areasTable } from "@workspace/db";
import bcrypt from "bcryptjs";

async function seed() {
  console.log("Seeding database...");

  const existingUsers = await db.select().from(usersTable);
  if (existingUsers.length > 0) {
    console.log("Database already seeded, skipping.");
    process.exit(0);
  }

  const managerHash = await bcrypt.hash("manager123", 10);
  const operatorHash = await bcrypt.hash("operator123", 10);

  await db.insert(usersTable).values([
    { email: "manager@5s.com", passwordHash: managerHash, role: "MANAGER" },
    { email: "operator@5s.com", passwordHash: operatorHash, role: "OPERATOR" },
  ]);

  await db.insert(areasTable).values([
    { name: "Assembly Line 1" },
    { name: "Assembly Line 2" },
    { name: "Welding Bay" },
    { name: "Paint Shop" },
    { name: "Quality Control Lab" },
    { name: "Packaging Station" },
  ]);

  console.log("Seed complete!");
  console.log("Login credentials:");
  console.log("  Manager:  manager@5s.com / manager123");
  console.log("  Operator: operator@5s.com / operator123");
  process.exit(0);
}

seed().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});
