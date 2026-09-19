-- Add a distinct app identity without changing any existing installation.
ALTER TABLE push_gateway_installations
    DROP CONSTRAINT push_gateway_installations_app_profile_check;
ALTER TABLE push_gateway_installations
    ADD CONSTRAINT push_gateway_installations_app_profile_check
    CHECK (app_profile IN (
        'buzz-ios-production', 'buzz-ios-sandbox',
        'buzz-capacitor-ios-production', 'buzz-capacitor-ios-sandbox'
    ));
