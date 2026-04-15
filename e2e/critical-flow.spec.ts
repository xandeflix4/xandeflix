import { test, expect } from '@playwright/test';

/**
 * Xandeflix Critical Flow E2E Test
 * Simulates Android TV usage (D-Pad) and validates telemetry.
 */
test.describe('Fluxo Crítico Xandeflix', () => {

  test.beforeEach(async ({ page }) => {
    // Mock do Login do Supabase
    await page.route('**/auth/v1/token?grant_type=password', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'fake-token',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'fake-refresh',
          user: { id: 'test-user-uuid', email: 'teste@xandeflix.com' }
        })
      });
    });

    // Mock do Profile do usuário (role user)
    await page.route('**/rest/v1/xandeflix_users?select=*&auth_user_id=eq.*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 'profile-uuid',
          auth_user_id: 'test-user-uuid',
          email: 'teste@xandeflix.com',
          role: 'user',
          playlist_url: '' // Força a ida para a SetupScreen se estiver vazio
        }])
      });
    });

    // Mock da Playlist M3U
    await page.route('**/*.m3u*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: '#EXTM3U\n#EXTINF:-1 tvg-id="CNN" tvg-name="CNN" tvg-logo="https://example.com/logo.png" group-title="Notícias",CNN Brasil\nhttp://example.com/stream.m3u8'
      });
    });

    // Mock da Telemetria (watch_history)
    await page.route('**/rest/v1/watch_history*', async route => {
      await route.fulfill({ status: 201 });
    });
  });

  test('deve realizar login, adicionar lista, navegar e validar telemetria', async ({ page }) => {
    await page.goto('/');

    // 1. Login
    await page.fill('[data-nav-id="login-id"]', 'teste@xandeflix.com');
    await page.fill('[data-nav-id="login-password"]', 'senha123');
    await page.click('[data-nav-id="login-submit"]');

    // 2. Adição de lista M3U (SetupScreen)
    // Esperamos a SetupScreen aparecer
    await expect(page.getByText('Configuracao Inicial')).toBeVisible({ timeout: 10000 });
    await page.fill('input[placeholder*="lista.m3u"]', 'http://servidor.com/lista.m3u');
    await page.click('text=Carregar Lista');

    // 3. Navegação Espacial (D-Pad)
    // Esperamos o HomeScreen carregar
    await expect(page.locator('[data-nav-id="hero-play"]')).toBeVisible({ timeout: 15000 });

    // Simulando setas do controle remoto
    await page.keyboard.press('ArrowDown'); // Vai para a primeira linha
    await page.keyboard.press('ArrowDown'); // Segunda linha
    await page.keyboard.press('ArrowRight'); // Segundo item da linha

    // 4. Play e Verificação do VideoPlayer
    await page.keyboard.press('Enter'); // Abre o player
    
    // Na Web, o VideoPlayer monta um <video> tag (preview mode)
    const video = page.locator('video');
    await expect(video).toBeVisible();

    // 5. Validação de Telemetria (após 10-15 segundos)
    console.log('Aguardando 15 segundos para validar sincronização de progresso...');
    
    // Captura a requisição de upsert para o watch_history
    const [request] = await Promise.all([
      page.waitForRequest(req => 
        req.url().includes('watch_history') && 
        req.method() === 'POST',
        { timeout: 45000 }
      ),
      // Forçamos o tempo passar se o app flushear a cada 15/30s
      page.waitForTimeout(35000) 
    ]);

    const postData = JSON.parse(request.postData() || '{}');
    expect(postData.media_id).toBeDefined();
    expect(postData.last_position).toBeGreaterThan(0);
    
    console.log('Telemetria validada com sucesso:', postData);
  });
});
