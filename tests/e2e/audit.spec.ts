import { expect, test } from '@playwright/test'

test('start an audit, poll to completion, reload the report and open history', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('LOCAL MOCK', { exact: true })).toBeVisible()
  await page.getByLabel('GitHubリポジトリURL').fill('https://github.com/example/browser-test')
  await page.getByRole('button', { name: '監査を開始', exact: true }).click()
  await expect(page.getByRole('heading', { name: '監査結果', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'AIレポート（モック）', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('完了', { exact: true })).toBeVisible()
  await expect(page.getByText('想定される影響', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'AIレポート（モック）', exact: true })).toBeVisible()
  await page.getByRole('navigation').getByRole('link', { name: '監査履歴', exact: true }).click()
  await expect(page.getByRole('link', { name: 'example/browser-test', exact: true }).first()).toBeVisible()
  await page.screenshot({ path: 'test-results/history.png', fullPage: true })
})
