require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const mongoose = require('mongoose');
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas'); // 이미지 생성 라이브러리 추가

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
// 2. 디스코드 로그인 및 리더보드 웹 API (기존과 동일)
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
// 4. 디스코드 봇 (/전적 - 이미지 생성 버전)
// ==========================================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

// 발로란트 맵 배경화면(Splash) URL 데이터베이스
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

// 둥근 모서리 박스를 그리는 함수
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
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: [{
    name: '전적', description: '발로란트 현재 티어와 최근 매치 정보를 카드로 보여줍니다.',
    options: [
      { name: '닉네임', type: 3, description: '발로란트 닉네임', required: true },
      { name: '태그', type: 3, description: '태그 (예: KR1)', required: true }
    ]
  }]});
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === '전적') {
    await interaction.deferReply(); 
    const name = interaction.options.getString('닉네임');
    const tag = interaction.options.getString('태그');

    try {
      // 1. 티어 및 점수 데이터 가져오기
      const mmrRes = await axios.get(`https://api.henrikdev.xyz/valorant/v1/mmr/kr/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, { headers: { Authorization: HENRIK_API_KEY } });
      // 2. 최근 1게임 매치 데이터 가져오기 (맵 이름 및 플레이 데이터 확인용)
      const matchRes = await axios.get(`https://api.henrikdev.xyz/valorant/v3/matches/kr/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?size=1`, { headers: { Authorization: HENRIK_API_KEY } });

      if (mmrRes.data.status === 200 && matchRes.data.status === 200 && matchRes.data.data.length > 0) {
        const mmrData = mmrRes.data.data;
        const matchData = matchRes.data.data[0];
        const mapName = matchData.metadata.map;

        // 캔버스 크기 설정 (800x450 비율)
        const canvas = createCanvas(800, 450);
        const ctx = canvas.getContext('2d');

        // 배경 맵 이미지 로드 및 그리기 (알 수 없는 맵이면 Ascent 기본 지정)
        const bgUrl = MAP_IMAGES[mapName] || MAP_IMAGES["Ascent"];
        const bg = await loadImage(bgUrl);
        ctx.drawImage(bg, 0, -50, 800, 550); // 이미지가 꽉 차도록 오프셋 조절

        // 반투명한 검은색 둥근 배경 박스 그리기
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        drawRoundRect(ctx, 40, 40, 720, 370, 20);

        // 유저 닉네임 텍스트
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 45px sans-serif';
        ctx.fillText(`${name} #${tag}`, 80, 110);

        // 최근 맵 이름 텍스트
        ctx.fillStyle = '#cccccc';
        ctx.font = '24px sans-serif';
        ctx.fillText(`최근 플레이 맵: ${mapName}`, 80, 155);

        // 티어 아이콘 그리기
        try {
          const tierIcon = await loadImage(mmrData.images.large);
          ctx.drawImage(tierIcon, 80, 190, 150, 150);
        } catch (e) { console.log('티어 이미지 로드 실패'); }

        // 티어 텍스트 및 점수
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 50px sans-serif';
        ctx.fillText(`${mmrData.currenttierpatched}`, 260, 255);

        ctx.fillStyle = '#ff4655'; // 발로란트 레드 포인트 컬러
        ctx.font = 'bold 36px sans-serif';
        ctx.fillText(`${mmrData.ranking_in_tier} 점 (RR)`, 260, 310);

        // 결과물 이미지 파일로 변환하여 디스코드로 전송
        const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'valorant-stats.png' });
        await interaction.editReply({ content: `**${name}**님의 최근 전적 카드입니다.`, files: [attachment] });
      } else {
        await interaction.editReply('전적 데이터를 가져오지 못했습니다. 최근 경쟁전 기록이 있는지 확인해 주세요.');
      }
    } catch (error) {
      await interaction.editReply('❌ 전적을 찾을 수 없거나 오류가 발생했습니다.');
    }
  }
});

app.listen(5000, () => console.log('Backend server running on port 5000'));