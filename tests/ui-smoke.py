import tempfile

from playwright.sync_api import sync_playwright


TOKEN = "ui-smoke-token-012345"


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1000}, extra_http_headers={"Authorization": f"Bearer {TOKEN}"})
    page = context.new_page()
    errors = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.goto("http://127.0.0.1:18432/ui")
    page.wait_for_load_state("networkidle")
    assert page.locator("#modelSettings").count() == 1
    assert page.locator("#modelApiKey").count() == 1
    assert page.locator("#modelProfiles").count() == 1
    assert page.locator("#modelSettings .settings-grid").evaluate("node => getComputedStyle(node).display") == "grid"
    assert page.locator("#modelSettings label").first.evaluate("node => getComputedStyle(node).display") == "grid"
    print(page.locator("#modelSettings .settings-grid").evaluate("node => [getComputedStyle(node).display, node.getAttribute('style')]"))
    page.locator("#token").fill(TOKEN)
    page.locator("#connect").click()
    page.wait_for_timeout(500)
    assert page.locator("#modelSettingsStatus").count() == 1
    page.screenshot(path=tempfile.gettempdir() + "/openclaw-workbench-model-settings.png", full_page=True)
    assert not errors, errors
    context.close()
    browser.close()
