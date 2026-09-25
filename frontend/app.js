const API_BASE_URL = 'https://valodashbord.onrender.com';
let currentUserId = null;

// 1. 디스코드 로그인 페이지 이동
function loginWithDiscord() {
  window.location.href = `${API_BASE_URL}/auth/discord`;
}

// 2. 페이지 로드 시 URL 파라미터 확인 및 UI 업데이트
window.onload = async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const userId = urlParams.get('userId');
  const username = urlParams.get('username');
  const avatar = urlParams.get('avatar');

  if (userId) {
    currentUserId = userId;
    
    // UI 토글
    document.getElementById('login-btn').classList.add('hidden');
    document.getElementById('user-info').classList.remove('hidden');
    
    // 유저 정보 렌더링
    document.getElementById('user-name').innerText = `${username}님 환영합니다`;
    document.getElementById('user-avatar').src = `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png`;
    
    // URL 정리 (보안 및 깔끔한 URL을 위해 파라미터 제거)
    window.history.replaceState({}, document.title, "/");
  }

  // 리더보드 데이터 로드
  loadLeaderboard();
};

// 3. 라이엇 ID 저장 요청
async function saveRiotId() {
  const riotId = document.getElementById('riot-id').value;
  const tagLine = document.getElementById('tag-line').value;

  if (!currentUserId || !riotId || !tagLine) {
    alert('모든 정보를 입력해주세요.');
    return;
  }

  try {
    await axios.post(`${API_BASE_URL}/auth/riot-id`, {
      userId: currentUserId,
      riotId,
      tagLine
    });
    alert('라이엇 ID가 성공적으로 연동되었습니다!');
  } catch (error) {
    alert('연동에 실패했습니다.');
    console.error(error);
  }
}

// 4. 리더보드 데이터 가져오기 및 차트 렌더링
async function loadLeaderboard() {
  try {
    const response = await axios.get(`${API_BASE_URL}/leaderboard`);
    const data = response.data;
    renderChart(data);
  } catch (error) {
    console.error('리더보드 데이터를 가져오지 못했습니다.', error);
  }
}

// 5. Chart.js를 이용한 리더보드 그래프 렌더링
function renderChart(data) {
  const ctx = document.getElementById('leaderboardChart').getContext('2d');
  
  const labels = data.map(user => user.discordName);
  const kdaData = data.map(user => user.kda);
  const hsData = data.map(user => user.hsPercentage);

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: '평균 KDA',
          data: kdaData,
          backgroundColor: '#8884d8',
          yAxisID: 'y'
        },
        {
          label: '헤드샷 비율 (%)',
          data: hsData,
          backgroundColor: '#82ca9d',
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          type: 'linear',
          display: true,
          position: 'left',
        },
        y1: {
          type: 'linear',
          display: true,
          position: 'right',
          grid: { drawOnChartArea: false } // 눈금선 겹침 방지
        }
      }
    }
  });
}