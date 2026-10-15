import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { getServerId } from "../support/helpers/server-id";
import { openHostSection, openSettingsHost } from "../support/helpers/settings";

const SET_CONFIG_REQUEST = "set_daemon_config_request";

async function openAgentsSettings(page: Page): Promise<void> {
  const serverId = getServerId();
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, serverId);
  await openHostSection(page, serverId, "agents");
}

function keepWarmSwitch(page: Page) {
  return page
    .getByTestId("host-page-prompt-cache-keep-warm-card")
    .getByRole("switch", { name: "Keep prompt cache warm" });
}

test.describe("Keep prompt cache warm setting", () => {
  test("saves to the host, shows progress, and survives a reload", async ({ page }, testInfo) => {
    const gate = await installDaemonWebSocketGate(page);
    await openAgentsSettings(page);
    const toggle = keepWarmSwitch(page);
    await expect(toggle).not.toBeChecked();
    await page.screenshot({ path: testInfo.outputPath("1-off.png"), fullPage: true });

    gate.holdNextClientRequest(SET_CONFIG_REQUEST);
    await toggle.click();
    await gate.waitForHeldClientRequest();
    await expect(toggle).toBeDisabled();
    await expect(page.getByTestId("host-page-prompt-cache-keep-warm-loading")).toHaveText(
      "Updating prompt cache setting…",
    );
    await page.screenshot({ path: testInfo.outputPath("2-saving.png"), fullPage: true });

    gate.releaseHeldClientRequest();
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
    await expect(page.getByTestId("host-page-prompt-cache-keep-warm-loading")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("3-on.png"), fullPage: true });

    await page.reload();
    await openAgentsSettings(page);
    await expect(keepWarmSwitch(page)).toBeChecked();

    await keepWarmSwitch(page).click();
    await expect(keepWarmSwitch(page)).not.toBeChecked();
  });

  test("a save lost with the connection leaves the host setting unchanged", async ({ page }) => {
    const gate = await installDaemonWebSocketGate(page);
    await openAgentsSettings(page);
    const toggle = keepWarmSwitch(page);
    await expect(toggle).not.toBeChecked();

    gate.holdNextClientRequest(SET_CONFIG_REQUEST);
    await toggle.click();
    await gate.waitForHeldClientRequest();
    await gate.drop();
    await expect(page.getByText("Connect to this host to manage agents")).toBeVisible();

    gate.restore();
    await expect(keepWarmSwitch(page)).not.toBeChecked({ timeout: 30_000 });
    await expect(keepWarmSwitch(page)).toBeEnabled();
  });
});
