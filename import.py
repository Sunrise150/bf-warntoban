import pandas as pd
from sqlalchemy import create_engine

# 数据库配置
db_config = {
    'user': 'koishi',
    'password': '123456',
    'host': 'localhost',
    'database': 'koishi',
    'port': 3306
}

# 创建引擎
engine = create_engine(f"mysql+pymysql://{db_config['user']}:{db_config['password']}@{db_config['host']}:{db_config['port']}/{db_config['database']}")

# 读取 CSV 文件
df = pd.read_csv('ban_records.csv')

# 列名映射 + 数据处理
df = df.rename(columns={
    '服务器': 'server',
    '玩家': 'player',
    '封禁原因': 'reason',
    '时间戳': 'timestamp',
    '总次数': 'total',
    '是否VBAN': 'isVBAN'
})

# 时间格式转换（ISO 8601 → MySQL DATETIME）
df['timestamp'] = pd.to_datetime(df['timestamp']).dt.strftime('%Y-%m-%d %H:%M:%S')

# 布尔值转换（是/否 → True/False）
df['isVBAN'] = df['isVBAN'].map({'是': True, '否': False})

# 写入数据库（排除 CSV 中的 ID 列，使用自增主键）
df.drop(columns=['ID'], errors='ignore').to_sql(
    name='ban_records',
    con=engine,
    if_exists='append',
    index=False
)

print("数据导入成功！")