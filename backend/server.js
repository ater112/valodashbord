require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const mongoose = require('mongoose');
const path = require('path');
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas'); // 중복 선언 방지 통합

// 맑은 고딕 한글 폰트 등록
try {
  GlobalFonts.registerFromPath(path.join(__dirname, 'fonts/malgun.ttf'), 'MalgunGothic');
  console.log('한글 폰트(MalgunGothic) 등록 완료');
} catch (e) {
  console.log('폰트 파일 로드 실패 (fonts/malgun.ttf 경로를 확인해주세요)');
}

const app = express();
app.use(cors());
app.use(express.json());

const { 
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, REDIRECT_URI, FRONTEND_URL, 
  DISCORD_WEBHOOK_URL, MONGODB_URI, HENRIK_API_KEY, DISCORD_BOT_TOKEN 
} = process.env;

// 1. MongoDB 연결
mongoose.connect(MONGODB_URI).then(() => console.log('MongoDB Connected'));

const userSchema = new mongoose.Schema({
  discordId: String, username: String, avatar: String,
  riotId: String, tagLine: String, lastMatchId: String,
  stats: { kda: Number, hsPercentage: Number }
});
const User = mongoose.model('User', userSchema);

// ==========================================
// 2. 디스코드 로그인 및 리더보드 웹 API
// ==========================================
app.get('/api/auth/discord', (req, res) => res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`));
app.get('/api/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const userRes = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
    const { id, username, avatar } = userRes.data;
    await User.findOneAndUpdate({ discordId: id }, { username, avatar }, { upsert: true, new: true });
    res.redirect(`${FRONTEND_URL}?userId=${id}&username=${encodeURIComponent(username)}&avatar=${avatar}`);
  } catch (error) { res.status(500).send('Login Failed'); }
});
app.post('/api/auth/riot-id', async (req, res) => {
  const { userId, riotId, tagLine } = req.body;
  try {
    const accountRes = await axios.get(`https://api.henrikdev.xyz/valorant/v1/account/${encodeURIComponent(riotId)}/${encodeURIComponent(tagLine)}`, { headers: { Authorization: HENRIK_API_KEY } });
    if (accountRes.data.status === 200) {
      await User.findOneAndUpdate({ discordId: userId }, { riotId, tagLine });
      res.status(200).json({ message: 'Success' });
    } else res.status(404).json({ message: 'Account not found' });
  } catch (error) { res.status(500).json({ message: 'Error' }); }
});
app.get('/api/leaderboard', async (req, res) => {
  try {
    const users = await User.find({ riotId: { $ne: null } });
    res.json(users.map(u => ({ discordName: u.username, kda: u.stats?.kda || 0, hsPercentage: u.stats?.hsPercentage || 0 })).sort((a, b) => b.kda - a.kda));
  } catch (error) { res.status(500).send('Error'); }
});
app.get('/ping', (req, res) => res.status(200).send('pong'));

// ==========================================
// 3. 전적 웹훅 (Cron Job) - 5분 주기
// ==========================================
cron.schedule('*/5 * * * *', async () => {
  try {
    const users = await User.find({ riotId: { $ne: null } });
    for (const user of users) {
      const matchRes = await axios.get(`https://api.henrikdev.xyz/valorant/v3/matches/kr/${encodeURIComponent(user.riotId)}/${encodeURIComponent(user.tagLine)}?size=1`, { headers: { Authorization: HENRIK_API_KEY } });
      if (matchRes.data.status !== 200 || !matchRes.data.data.length) continue;
      const latestMatch = matchRes.data.data[0];
      if (user.lastMatchId !== latestMatch.metadata.matchid) {
        const playerData = latestMatch.players.all_players.find(p => p.name.toLowerCase() === user.riotId.toLowerCase() && p.tag.toLowerCase() === user.tagLine.toLowerCase());
        if (playerData) {
          const { kills, deaths, assists, headshots, bodyshots, legshots } = playerData.stats;
          const kda = deaths === 0 ? kills + assists : ((kills + assists) / deaths).toFixed(2);
          const hsPercentage = (headshots + bodyshots + legshots) === 0 ? 0 : Math.round((headshots / (headshots + bodyshots + legshots)) * 100);
          const isWin = latestMatch.teams[playerData.team.toLowerCase()]?.has_won || false;
          user.lastMatchId = latestMatch.metadata.matchid;
          user.stats = { kda: parseFloat(kda), hsPercentage };
          await user.save();
          if (DISCORD_WEBHOOK_URL) await axios.post(DISCORD_WEBHOOK_URL, { content: `🎮 **${user.username}**님이 매치를 완료했습니다!\n**결과:** ${isWin ? "🔵 승리" : "🔴 패배"} (${latestMatch.metadata.map})\n**KDA:** ${kills}/${deaths}/${assists} (${kda})\n**헤드샷:** ${hsPercentage}%` });
        }
      }
    }
  } catch (error) {}
});

// ==========================================
// 4. 디스코드 봇 (슬래시 명령어 전체 - 한글 전적 카드 포함)
// ==========================================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

const MAP_IMAGES = {
  "Ascent": "https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/splash.png",
  "Split": "https://media.valorant-api.com/maps/d960549e-485c-e861-8d71-aa9d1aed12a2/splash.png",
  "Fracture": "https://media.valorant-api.com/maps/b529448b-4d3e-92a0-9e85-a45558836592/splash.png",
  "Bind": "https://media.valorant-api.com/maps/2c9d57ec-4431-9c5e-2939-8f9ef6dd5cba/splash.png",
  "Breeze": "https://media.valorant-api.com/maps/2c4b5742-491c-4b68-6c0b-4876b50b7b13/splash.png",
  "Lotus": "https://media.valorant-api.com/maps/2fe4ed3a-450a-948b-6d6b-e89a78e680a9/splash.png",
  "Pearl": "https://media.valorant-api.com/maps/fd267378-4d1d-484f-ff52-77821ed10dc2/splash.png",
  "Haven": "https://media.valorant-api.com/maps/2bee0dc9-4ffe-519b-1cbd-7fbe763a6047/splash.png",
  "Icebox": "https://media.valorant-api.com/maps/e2ad5c54-4114-a870-9641-8ea21279579a/splash.png",
  "Sunset": "https://media.valorant-api.com/maps/92584fbe-486a-b1b2-9faa-39b0f486b498/splash.png",
  "Abyss": "https://media.valorant-api.com/maps/224b0a95-48b9-f703-1bd8-67aca101a61f/splash.png"
};

function drawRoundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();
}

client.once('ready', async () => {
  console.log(`디스코드 봇 준비 완료!`);
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: [
    {
      name: '전적', description: '발로란트 현재 티어와 최근 매치 세부 정보를 카드로 보여줍니다.',
      options: [
        { name: '닉네임', type: 3, description: '발로란트 닉네임', required: true },
        { name: '태그', type: 3, description: '태그 (예: KR1)', required: true }
      ]
    },
    { name: '헤샷순위', description: '웹 대시보드에 연동된 유저들의 헤드샷 명중률 순위를 보여줍니다.' },
    { name: '킬뎃순위', description: '웹 대시보드에 연동된 유저들의 KDA 순위를 보여줍니다.' },
    { name: '이번주의버스기사', description: '이번 주에 가장 높은 KDA를 기록한 최고의 버스 기사를 발표합니다!' }
  ]});
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (commandName === '전적') {
    await interaction.deferReply(); 
    const name = interaction.options.getString('닉네임');
    const tag = interaction.options.getString('태그');

    try {
      const mmrRes = await axios.get(`https://api.henrikdev.xyz/valorant/v1/mmr/kr/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, { headers: { Authorization: HENRIK_API_KEY } });
      const matchRes = await axios.get(`https://api.henrikdev.xyz/valorant/v3/matches/kr/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?size=1`, { headers: { Authorization: HENRIK_API_KEY } });

      if (mmrRes.data.status === 200 && matchRes.data.status === 200 && matchRes.data.data.length > 0) {
        const mmrData = mmrRes.data.data;
        const matchData = matchRes.data.data[0];
        const mapName = matchData.metadata.map;

        const playerData = matchData.players.all_players.find(p => p.name.toLowerCase() === name.toLowerCase() && p.tag.toLowerCase() === tag.toLowerCase());
        
        let kdaStr = "0 / 0 / 0 (0.00)";
        let hsStr = "0%";
        let resultStr = "승리";
        let resultColor = "#00d26a";

        if (playerData) {
          const { kills, deaths, assists, headshots, bodyshots, legshots } = playerData.stats;
          const kda = deaths === 0 ? (kills + assists).toFixed(2) : ((kills + assists) / deaths).toFixed(2);
          kdaStr = `${kills} / ${deaths} / ${assists} (${kda})`;

          const totalHits = headshots + bodyshots + legshots;
          const hsPerc = totalHits === 0 ? 0 : Math.round((headshots / totalHits) * 100);
          hsStr = `${hsPerc}%`;

          const isWin = matchData.teams[playerData.team.toLowerCase()]?.has_won || false;
          resultStr = isWin ? "승리" : "패배";
          resultColor = isWin ? "#00d26a" : "#ff4655";
        }

        const canvas = createCanvas(800, 450);
        const ctx = canvas.getContext('2d');

        const bgUrl = MAP_IMAGES[mapName] || MAP_IMAGES["Ascent"];
        const bg = await loadImage(bgUrl);
        ctx.drawImage(bg, 0, -50, 800, 550);

        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        drawRoundRect(ctx, 40, 30, 720, 390, 20);

        // 닉네임 (한글 폰트 적용)
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 38px MalgunGothic';
        ctx.fillText(`${name} #${tag}`, 70, 85);

        // 최근 맵 이름 (한글)
        ctx.fillStyle = '#aaaaaa';
        ctx.font = '20px MalgunGothic';
        ctx.fillText(`최근 맵: ${mapName}`, 70, 120);

        // 승리 / 패배
        ctx.fillStyle = resultColor;
        ctx.font = 'bold 22px MalgunGothic';
        ctx.fillText(resultStr, 640, 85);

        try {
          const tierIcon = await loadImage(mmrData.images.large);
          ctx.drawImage(tierIcon, 70, 145, 120, 120);
        } catch (e) {}

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 32px MalgunGothic';
        ctx.fillText(`${mmrData.currenttierpatched}`, 210, 190);

        ctx.fillStyle = '#ff4655';
        ctx.font = 'bold 26px MalgunGothic';
        ctx.fillText(`${mmrData.ranking_in_tier} RR`, 210, 230);

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(70, 285);
        ctx.lineTo(730, 285);
        ctx.stroke();

        ctx.fillStyle = '#aaaaaa';
        ctx.font = '16px MalgunGothic';
        ctx.fillText('최근 KDA', 70, 320);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 24px MalgunGothic';
        ctx.fillText(kdaStr, 70, 355);

        ctx.fillStyle = '#aaaaaa';
        ctx.font = '16px MalgunGothic';
        ctx.fillText('헤드샷 명중률', 500, 320);
        ctx.fillStyle = '#00d26a';
        ctx.font = 'bold 24px MalgunGothic';
        ctx.fillText(hsStr, 500, 355);

        const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'valorant-stats.png' });
        await interaction.editReply({ content: `**${name}**님의 최근 전적 카드입니다.`, files: [attachment] });
      } else {
        await interaction.editReply('❌ 전적 데이터를 가져오지 못했습니다.');
      }
    } catch (error) {
      await interaction.editReply('❌ 전적을 찾을 수 없거나 오류가 발생했습니다.');
    }
  }

  else if (commandName === '헤샷순위') {
    await interaction.deferReply();
    try {
      const users = await User.find({ riotId: { $ne: null } }).sort({ 'stats.hsPercentage': -1 });
      if (users.length === 0) return interaction.editReply('⚠️ 아직 대시보드에 연동된 유저가 없습니다!');
      const embed = new EmbedBuilder()
        .setColor('#00d26a')
        .setTitle('🎯 서버 헤드샷 명중률 순위')
        .setDescription(users.map((u, i) => `**${i + 1}위** | ${u.username} (${u.riotId}#${u.tagLine}) — **${u.stats?.hsPercentage || 0}%**`).join('\n'));
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply('❌ 순위를 불러오는 중 오류가 발생했습니다.');
    }
  }

  else if (commandName === '킬뎃순위') {
    await interaction.deferReply();
    try {
      const users = await User.find({ riotId: { $ne: null } }).sort({ 'stats.kda': -1 });
      if (users.length === 0) return interaction.editReply('⚠️ 아직 대시보드에 연동된 유저가 없습니다!');
      const embed = new EmbedBuilder()
        .setColor('#ff4655')
        .setTitle('⚔️ 서버 KDA 순위')
        .setDescription(users.map((u, i) => `**${i + 1}위** | ${u.username} (${u.riotId}#${u.tagLine}) — **KDA ${u.stats?.kda || 0}점**`).join('\n'));
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply('❌ 순위를 불러오는 중 오류가 발생했습니다.');
    }
  }

  else if (commandName === '이번주의버스기사') {
    await interaction.deferReply();
    try {
      const users = await User.find({ riotId: { $ne: null } }).sort({ 'stats.kda': -1 });
      if (users.length === 0 || !users[0].riotId) return interaction.editReply('⚠️ 연동된 유저가 없습니다!');
      const driver = users[0];
      const embed = new EmbedBuilder()
        .setColor('#ffd700')
        .setTitle('👑 [이번 주 서버 최고의 버스 기사]')
        .setDescription(`이번 주 가장 강력한 기사님은 바로...\n\n🎉 **${driver.username}** (${driver.riotId}#${driver.tagLine}) 님입니다!\n\n🔥 **평균 KDA:** **${driver.stats?.kda || 0}점**`);
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply('❌ 버스 기사를 선정하는 중 오류가 발생했습니다.');
    }
  }
});

client.login(DISCORD_BOT_TOKEN);
app.listen(5000, () => console.log('Backend server running on port 5000'));