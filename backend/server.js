require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const mongoose = require('mongoose');

const app = express();
app.use(cors()); // 프론트엔드(Vanilla JS)와의 통신 허용
app.use(express.json());

const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, REDIRECT_URI, FRONTEND_URL, DISCORD_WEBHOOK_URL, HENRIK_API_KEY } = process.env;

// MongoDB 유저 스키마 간략화
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
// 1. 디스코드 OAuth2 로그인 및 연동
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
    
    // DB 저장 로직 (생략: 기존 코드와 동일)
    
    // 프론트엔드(index.html)로 리다이렉트하며 데이터 전달
    res.redirect(`${FRONTEND_URL}?userId=${id}&username=${encodeURIComponent(username)}&avatar=${avatar}`);
  } catch (error) {
    res.status(500).send('Login Failed');
  }
});

app.post('/api/auth/riot-id', async (req, res) => {
  const { userId, riotId, tagLine } = req.body;
  // DB에 riotId, tagLine 업데이트 로직 구현
  res.status(200).json({ message: 'Success' });
});

// ==========================================
// 2. 리더보드 데이터 제공 API
// ==========================================
app.get('/api/leaderboard', async (req, res) => {
  // DB에서 유저 스탯을 가져와 KDA 순으로 정렬 후 응답
  const mockData = [
    { discordName: 'User1', kda: 1.5, hsPercentage: 25 },
    { discordName: 'User2', kda: 1.2, hsPercentage: 20 },
    { discordName: 'User3', kda: 0.9, hsPercentage: 15 },
  ];
  res.json(mockData);
});

// UptimeRobot 서버 깨우기용 (Ping) 라우터
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// ==========================================
// 3. 전적 웹훅 (Cron Job)
// ==========================================
cron.schedule('*/5 * * * *', async () => {
  console.log('매치 트래킹 실행...');
  // 여기에 HenrikDev API 호출 및 웹훅 전송 로직 구현 (이전 코드와 동일)
});

// 서버 실행
app.listen(5000, () => console.log('Backend server running on port 5000'));