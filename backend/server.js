require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, REDIRECT_URI, FRONTEND_URL, DISCORD_WEBHOOK_URL, MONGODB_URI } = process.env;

// MongoDB 연결 (필수)
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
    
    // DB 유저 생성 또는 업데이트 (기본 정보 저장)
    await User.findOneAndUpdate(
      { discordId: id },
      { username, avatar },
      { upsert: true, new: true }
    );
    
    res.redirect(`${FRONTEND_URL}?userId=${id}&username=${encodeURIComponent(username)}&avatar=${avatar}`);
  } catch (error) {
    res.status(500).send('Login Failed');
  }
});

// 라이엇 ID 실제 존재 여부 검증 및 DB 저장 (Henrik API 사용)
app.post('/api/auth/riot-id', async (req, res) => {
  const { userId, riotId, tagLine } = req.body;
  try {
    const accountRes = await axios.get(`https://api.henrikdev.xyz/valorant/v1/account/${encodeURIComponent(riotId)}/${encodeURIComponent(tagLine)}`);

    // 계정이 존재하면 200 상태 코드가 반환됨
    if (accountRes.data.status === 200) {
      await User.findOneAndUpdate(
        { discordId: userId },
        { riotId, tagLine }
      );
      res.status(200).json({ message: 'Success' });
    } else {
      res.status(404).json({ message: 'Account not found' });
    }
  } catch (error) {
    res.status(500).json({ message: '계정을 찾을 수 없습니다. 아이디와 태그를 확인해 주세요.' });
  }
});

// ==========================================
// 2. 리더보드 데이터 제공 API
// ==========================================
app.get('/api/leaderboard', async (req, res) => {
  try {
    // 라이엇 아이디가 연동된 유저만 불러오기
    const users = await User.find({ riotId: { $ne: null } });
    
    const data = users.map(user => ({
      discordName: user.username,
      kda: user.stats?.kda || 0,
      hsPercentage: user.stats?.hsPercentage || 0
    })).sort((a, b) => b.kda - a.kda); // KDA 높은 순 정렬

    res.json(data);
  } catch (error) {
    res.status(500).send('Error fetching leaderboard');
  }
});

app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// ==========================================
// 3. 전적 웹훅 (Cron Job) - 5분마다 실행
// ==========================================
cron.schedule('*/5 * * * *', async () => {
  console.log('매치 트래킹 실행...');
  try {
    const users = await User.find({ riotId: { $ne: null } });

    for (const user of users) {
      // Henrik API를 통해 해당 유저의 최신 매치 1개만 가져오기 (한국 서버: kr)
      const matchUrl = `https://api.henrikdev.xyz/valorant/v3/matches/kr/${encodeURIComponent(user.riotId)}/${encodeURIComponent(user.tagLine)}?size=1`;
      const matchRes = await axios.get(matchUrl);

      if (matchRes.data.status !== 200 || !matchRes.data.data.length) continue;

      const latestMatch = matchRes.data.data[0];

      // 저장된 마지막 매치 ID와 다르면 = 방금 게임을 한 판 끝냈다면
      if (user.lastMatchId !== latestMatch.metadata.matchid) {
        
        // 매치 안에서 해당 유저의 데이터만 쏙 뽑아내기
        const playerData = latestMatch.players.all_players.find(
          p => p.name.toLowerCase() === user.riotId.toLowerCase() && p.tag.toLowerCase() === user.tagLine.toLowerCase()
        );

        if (playerData) {
          // 킬뎃, 헤드샷 데이터 계산
          const { kills, deaths, assists, headshots, bodyshots, legshots } = playerData.stats;
          const kda = deaths === 0 ? kills + assists : ((kills + assists) / deaths).toFixed(2);
          
          const totalHits = headshots + bodyshots + legshots;
          const hsPercentage = totalHits === 0 ? 0 : Math.round((headshots / totalHits) * 100);

          // 승패 여부 계산
          const teamData = latestMatch.teams[playerData.team.toLowerCase()];
          const isWin = teamData ? teamData.has_won : false;
          const matchResult = isWin ? "🔵 **승리**" : "🔴 **패배**";
          const mapName = latestMatch.metadata.map;

          // DB에 유저의 최신 정보 업데이트
          user.lastMatchId = latestMatch.metadata.matchid;
          user.stats = { kda: parseFloat(kda), hsPercentage };
          await user.save();

          // 디스코드 채널로 예쁜 알림 보내기
          if (DISCORD_WEBHOOK_URL) {
            await axios.post(DISCORD_WEBHOOK_URL, {
              content: `🎮 **${user.username}**님이 매치를 완료했습니다!\n\n**결과:** ${matchResult} (${mapName})\n**KDA:** ${kills}/${deaths}/${assists} (${kda})\n**헤드샷:** ${hsPercentage}%`
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('트래킹 에러 발생:', error.message);
  }
});

// 서버 실행
app.listen(5000, () => console.log('Backend server running on port 5000'));