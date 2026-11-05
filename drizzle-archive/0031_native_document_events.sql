-- Notifications are hints, delivered on commit. No edit history is stored.
CREATE FUNCTION notify_document_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('neuton_document_changes', NEW.shop_id::text);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER document_version_notification AFTER INSERT OR UPDATE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION notify_document_change();
