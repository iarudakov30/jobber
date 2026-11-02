import { pgTable, serial, text, real, integer } from 'drizzle-orm/pg-core';

export const products = pgTable('products', {
  id: serial('id').primaryKey(),
  name: text('name'),
  category: text('category'),
  price: real('price'),
  stock: integer('stock'),
  rating: real('rating'),
  description: text('description'),
  // Where the product came from (e.g. "job:<jobId>:<index>"). Unique, so a redelivered
  // LoadProducts message inserts nothing the second time; null for rows loaded before it existed.
  sourceRef: text('source_ref').unique(),
});
