const { createClient } = require("@supabase/supabase-js");

// Supabase credentials are loaded from backend/.env.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ Warning: SUPABASE_URL or SUPABASE_KEY is missing in environment variables. Database queries will fail.");
  
  // A helper function that returns a proxy supporting arbitrary query builder chaining.
  // When the final chain is awaited (by accessing .then), it resolves with an error object.
  const makeFallbackQuery = () => {
    return new Proxy(() => {}, {
      get: (target, prop) => {
        if (prop === "then") {
          return (resolve) => resolve({
            data: null,
            error: { message: "Supabase client not initialized due to missing credentials." }
          });
        }
        return makeFallbackQuery();
      },
      apply: () => {
        return makeFallbackQuery();
      }
    });
  };

  supabase = new Proxy({}, {
    get: (target, prop) => {
      return makeFallbackQuery();
    }
  });
} else {
  // Shared Supabase client used by services.
  supabase = createClient(supabaseUrl, supabaseKey);
}

module.exports = supabase;
