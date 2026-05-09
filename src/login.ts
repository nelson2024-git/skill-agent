/**
 * Copilot Device Flow 登录工具
 *
 * 通过 GitHub Device Authorization Flow 获取 Copilot OAuth Token (gho_xxx)
 * 这是 VS Code Copilot 扩展使用的同样认证方式
 *
 * 用法: npx tsx src/login.ts
 */

const CLIENT_ID = "Iv1.b507a08c87ecfe98"; // GitHub Copilot CLI 的 Client ID
const SCOPE = "copilot";

async function startDeviceFlow() {
  console.log("=== GitHub Copilot Device Flow 登录 ===\n");

  // Step 1: 获取 device code
  const resp = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: SCOPE,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`❌ 请求失败: HTTP ${resp.status}`);
    console.error(body);
    process.exit(1);
  }

  const data = await resp.json() as any;
  const { device_code, user_code, verification_uri, expires_in, interval } = data;

  console.log("📋 请在浏览器中打开以下地址:");
  console.log(`\n   ${verification_uri}\n`);
  console.log(`🔑 输入验证码: ${user_code}\n`);
  console.log(`⏱️  有效期: ${expires_in} 秒\n`);

  // Step 2: 轮询等待用户授权
  const pollInterval = (interval || 5) * 1000;
  const startTime = Date.now();
  const maxWait = (expires_in || 900) * 1000;

  while (Date.now() - startTime < maxWait) {
    await new Promise(r => setTimeout(r, pollInterval));

    const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const tokenData = await tokenResp.json() as any;

    if (tokenData.error) {
      if (tokenData.error === "authorization_pending") {
        process.stdout.write(".");
        continue;
      }
      if (tokenData.error === "slow_down") {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      if (tokenData.error === "expired_token") {
        console.error("\n❌ 验证码已过期，请重新运行");
        process.exit(1);
      }
      console.error(`\n❌ 授权失败: ${tokenData.error_description || tokenData.error}`);
      process.exit(1);
    }

    // 成功!
    const accessToken = tokenData.access_token;
    console.log("\n\n✅ 授权成功！\n");
    console.log(`Token: ${accessToken.substring(0, 12)}...${accessToken.substring(accessToken.length - 4)}`);
    console.log(`类型:  ${accessToken.substring(0, 4)}_ (OAuth Token)`);
    console.log("");
    console.log("请将以下内容写入 .env 文件:");
    console.log(`COPILOT_GITHUB_TOKEN=${accessToken}`);
    console.log("");

    // 验证 token
    const verifyResp = await fetch("https://api.github.com/copilot_internal/v2/token", {
      headers: {
        "Authorization": `token ${accessToken}`,
        "Accept": "application/json",
        "User-Agent": "skill-agent",
      },
    });

    if (verifyResp.ok) {
      const vData = await verifyResp.json() as any;
      const expiresAt = new Date(vData.expires_at * 1000);
      console.log(`🎉 Copilot Token 验证通过! 有效期至: ${expiresAt.toLocaleString("zh-CN")}`);
    } else {
      console.log("⚠️ Token 获取成功，但 Copilot 验证未通过（可能账号未开通 Copilot 订阅）");
    }

    return;
  }

  console.error("\n❌ 等待超时，请重新运行");
}

startDeviceFlow().catch(console.error);
