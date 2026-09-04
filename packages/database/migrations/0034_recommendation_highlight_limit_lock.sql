-- Deferred constraint triggers otherwise read independent commit snapshots.  Locking
-- the parent first makes concurrent direct SQL writers serialize before recounting.
CREATE OR REPLACE FUNCTION "enforce_recommendation_highlight_limit"() RETURNS trigger AS $$
BEGIN
  UPDATE "recommendation_lists" SET "created_at" = "created_at"
    WHERE "id" = NEW."recommendation_list_id";
  IF (SELECT count(*) FROM "recommendation_list_items"
      WHERE "recommendation_list_id" = NEW."recommendation_list_id" AND "highlighted") > 3 THEN
    RAISE EXCEPTION 'recommendation lists may highlight at most three items';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
