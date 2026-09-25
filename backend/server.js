require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const mongoose = require('mongoose');
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder } = require('discord.js'); // 추가된 봇 라이브러리

const app = express();
app.use(cors());
app.use(express.json());

const { 
  DISCORD_CLIENT_ID, 
  DISCORD_CLIENT_SECRET, 
  REDIRECT_URI, 
  FRONTEND_URL, 
  DISCORD_WEBHOOK_URL, 
  MONGODB_URI, 
  HENRIK_API_KEY,
  DISCORD_BOT_TOKEN // 새로 추가될 환경 변수
} = process.env;

// 1. MongoDB 연결
mongoose.connect(MONGODB_URI).then(() => console.log('MongoDB Connected'));

const userSchema = new mongoose.Schema({
  discordId: String,
  username: String,
  avatar: String,
  riotId: String,
  tagLine: String,
  lastMatchId: String,
  stats: { kda: Number, hsPercentage: Number }
});
const User = mongoose.model('User', userSchema);

// ==========================================
// 2. 디스코드 OAuth2 로그인 및 연동
// ==========================================
app.get('/api/auth/discord', (req, res) => {
  const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
  res.redirect(discordAuthUrl);
});

app.get('/api/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });

    const { id, username, avatar } = userRes.data;
    
    await User.findOneAndUpdate({ discordId: id }, { username, avatar }, { upsert: true, new: true });
    res.redirect(`${FRONTEND_URL}?userId=${id}&username=${encodeURIComponent(username)}&avatar=${avatar}`);
  } catch (error) {
    res.status(500).send('Login Failed');
  }
});

app.post('/api/auth/riot-id', async (req, res) => {
  const { userId, riotId, tagLine } = req.body;
  try {
    const accountRes = await axios.get(`https://api.henrikdev.xyz/valorant/v1/account/${encodeURIComponent(riotId)}/${encodeURIComponent(tagLine)}`, { headers: { Authorization: HENRIK_API_KEY } });
    if (accountRes.data.status === 200) {
      await User.findOneAndUpdate({ discordId: userId }, { riotId, tagLine });
      res.status(200).json({ message: 'Success' });
    } else res.status(404).json({ message: 'Account not found' });
  } catch (error) {
    res.status(500).json({ message: 'Error' });
  }
});

// ==========================================
// 3. 리더보드 데이터 제공 API
// ==========================================
app.get('/api/leaderboard', async (req, res) => {
  try {
    const users = await User.find({ riotId: { $ne: null } });
    const data = users.map(user => ({
      discordName: user.username,
      kda: user.stats?.kda || 0,
      hsPercentage: user.stats?.hsPercentage || 0
    })).sort((a, b) => b.kda - a.kda);
    res.json(data);
  } catch (error) {
    res.status(500).send('Error');
  }
});

app.get('/ping', (req, res) => res.status(200).send('pong'));

// ==========================================
// 4. 전적 웹훅 (Cron Job) - 5분 주기
// ==========================================
cron.schedule('*/5 * * * *', async () => {
  try {
    const users = await User.find({ riotId: { $ne: null } });
    for (const user of users) {
      const matchUrl = `https://api.henrikdev.xyz/valorant/v3/matches/kr/${encodeURIComponent(user.riotId)}/${encodeURIComponent(user.tagLine)}?size=1`;
      const matchRes = await axios.get(matchUrl, { headers: { Authorization: HENRIK_API_KEY } });
      if (matchRes.data.status !== 200 || !matchRes.data.data.length) continue;

      const latestMatch = matchRes.data.data[0];
      if (user.lastMatchId !== latestMatch.metadata.matchid) {
        const playerData = latestMatch.players.all_players.find(p => p.name.toLowerCase() === user.riotId.toLowerCase() && p.tag.toLowerCase() === user.tagLine.toLowerCase());
        if (playerData) {
          const { kills, deaths, assists, headshots, bodyshots, legshots } = playerData.stats;
          const kda = deaths === 0 ? kills + assists : ((kills + assists) / deaths).toFixed(2);
          const totalHits = headshots + bodyshots + legshots;
          const hsPercentage = totalHits === 0 ? 0 : Math.round((headshots / totalHits) * 100);

          const teamData = latestMatch.teams[playerData.team.toLowerCase()];
          const isWin = teamData ? teamData.has_won : false;
          
          user.lastMatchId = latestMatch.metadata.matchid;
          user.stats = { kda: parseFloat(kda), hsPercentage };
          await user.save();

          if (DISCORD_WEBHOOK_URL) {
            await axios.post(DISCORD_WEBHOOK_URL, {
              content: `🎮 **${user.username}**님이 매치를 완료했습니다!\n\n**결과:** ${isWin ? "🔵 승리" : "🔴 패배"} (${latestMatch.metadata.map})\n**KDA:** ${kills}/${deaths}/${assists} (${kda})\n**헤드샷:** ${hsPercentage}%`
            });
          }
        }
      }
    }
  } catch (error) { console.error('트래킹 에러:', error.message); }
});

// ==========================================
// 5. 디스코드 봇 (슬래시 명령어 /전적)
// ==========================================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

// 명령어 구조 정의
const commands = [
  {
    name: '전적',
    description: '발로란트 현재 티어와 랭크 포인트를 검색합니다.',
    options: [
      { name: '닉네임', type: 3, description: '발로란트 닉네임', required: true },
      { name: '태그', type: 3, description: '태그 (예: KR1)', required: true }
    ]
  }
];

client.once('ready', async () => {
  console.log(`디스코드 봇 로그인 완료: ${client.user.tag}`);
  try {
    // 봇이 켜질 때 디스코드 서버에 명령어(/전적)를 등록
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
    console.log('슬래시 명령어 등록 완료');
  } catch (error) {
    console.error('명령어 등록 에러:', error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === '전적') {
    // API 호출에 시간이 걸릴 수 있으므로 '봇이 생각하는 중...' 상태를 먼저 띄움
    await interaction.deferReply(); 
    
    const name = interaction.options.getString('닉네임');
    const tag = interaction.options.getString('태그');

    try {
      // 랭크(MMR) 데이터 가져오기
      const res = await axios.get(`https://api.henrikdev.xyz/valorant/v1/mmr/kr/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, {
        headers: { Authorization: HENRIK_API_KEY }
      });

      if (res.data.status === 200) {
        const data = res.data.data;
        
        // 디스코드 Embed(카드 폼) 생성
        const embed = new EmbedBuilder()
          .setColor('#ff4655') // 발로란트 레드 컬러
          .setTitle(`🎮 ${name}#${tag} 님의 전적`)
          .setThumbnail(data.images.small) // 현재 티어 아이콘
          .addFields(
            { name: '현재 티어', value: `${data.currenttierpatched}`, inline: true },
            { name: '랭크 포인트', value: `${data.ranking_in_tier} RR`, inline: true },
            { name: '최근 증감', value: `${data.mmr_change_to_last_game > 0 ? '+' : ''}${data.mmr_change_to_last_game}`, inline: true }
          )
          .setFooter({ text: '데이터 연동: HenrikDev API' });

        await interaction.editReply({ embeds: [embed] });
      }
    } catch (error) {
      await interaction.editReply('❌ 전적을 찾을 수 없습니다. 닉네임과 태그를 정확히 입력했는지 확인해 주세요. (최근 경쟁전을 플레이한 계정이어야 합니다.)');
    }
  }
});

// 봇 실행
client.login(DISCORD_BOT_TOKEN);

// 웹 서버 실행
app.listen(5000, () => console.log('Backend server running on port 5000'));