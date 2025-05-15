
import { Context, Schema, h, Element, Logger, } from 'koishi'
import sharp from 'sharp'
import path from 'path'
import {promises as fs} from 'fs'
import { createWriteStream } from 'fs'
import {resolve } from 'path'
export const name = 'warntoban'
export const inject = ['console','database']

const logger = new Logger(name)

// 定义一个延迟函数，接受毫秒数作为参数，返回一个Promise


// 声明数据库表结构
declare module 'koishi' {
  interface Tables {
    ban_records: {
      id: number
      server: string
      player: string
      reason: string
      timestamp: Date
      total?: number
      isVBAN:boolean
    }
    confession_progress:{
      userId:string
      days:number
      lastDate:string
    }
    report_with_evidence: ReportWithEvidence
    report_without_evidence: ReportWithoutEvidence
  }
}


export interface Config {
  targetGuild: string
  adminUserId1: string
  adminUserId2: string
  adminUserId3: string
  maxViolations: number
  maxRepeat: number
  storagePath: string
  maxSizeMB:number
  cacheTime:number
}

export const Config: Schema<Config> = Schema.object({
  targetGuild: Schema.string().required().description('目标群组 ID'),
  adminUserId1: Schema.string().required().description('管理员用户 ID1'),
  adminUserId2: Schema.string().required().description('管理员用户 ID2'),
  adminUserId3: Schema.string().required().description('管理员用户 ID3'),
  maxViolations: Schema.number().min(1).default(2).description('最大违规次数'),
  maxRepeat: Schema.number().min(1).default(3).description('最大重复间隔'),
  storagePath: Schema.string()
    .default('data/baka-images')
    .description('本地存储路径（相对项目根目录）'),
  maxSizeMB: Schema.number()
    .default(5)
    .min(1)
    .max(20)
    .description('最大图片大小 (MB)'),
  cacheTime: Schema.number()
    .default(300000)
    .description('缓存刷新间隔（毫秒）'),
})

interface BanRecord{
  id: number
  server: string
  player: string
  reason: string
  timestamp: Date
}

interface ReportWithEvidence {
  id: number
  reporter_id: string
  reported_id: string
  reason: string
  evidence_path: string
  created_at: Date
}

interface ReportWithoutEvidence {
  id: number
  reporter_id: string
  reported_id: string
  reason: string
  created_at: Date
}

// 脏话过滤列表（可根据需要扩展），这里需要进行二次设计
const BAD_WORDS = ['滚','傻逼','皇帝',]
//额外的第三方指令



async function exportBanRecordsToCSV(ctx: Context, outputPath: string = 'ban_records.csv') {
  try {
    // 获取所有记录
    const records = await ctx.database.get('ban_records', {})
    
    if (records.length === 0) {
      return '数据库中没有封禁记录'
    }

    // 构建CSV内容
    let csv = '\uFEFF' // UTF-8 BOM，防止中文乱码
    csv += 'ID,服务器,玩家,封禁原因,时间戳,总次数,是否VBAN\n'
    
    records.forEach(record => {
      // 处理可能包含逗号或换行符的字段
      const escapeCsv = (str: string) => {
        if (str === null || str === undefined) return ''
        return `"${String(str).replace(/"/g, '""')}"`
      }

      csv += [
        record.id,
        escapeCsv(record.server),
        escapeCsv(record.player),
        escapeCsv(record.reason),
        record.timestamp.toISOString(),
        record.total || 0,
        record.isVBAN ? '是' : '否'
      ].join(',') + '\n'
    })

    // 确保输出目录存在
    const dir = path.dirname(outputPath)
    await fs.mkdir(dir, { recursive: true }).catch(() => {})
    
    // 写入文件
    await fs.writeFile(outputPath, csv, 'utf8')
    
    return `成功导出 ${records.length} 条封禁记录到 ${outputPath}`
  } catch (error) {
    ctx.logger('export').error('导出封禁记录失败:', error)
    return '导出封禁记录时出错: ' + error.message
  }
}


export async function apply(ctx: Context, config: Config) {

  // 优化正则表达式（支持中英文符号和空格）
  // const pattern = /在服务器\s*(\S+)\s*中踢出玩家\s*(\S+)\s*成功原因\s*[:：]\s*([^]+)/
  // 在模型定义中扩展索引
  ctx.model.extend('ban_records', {
    id: 'unsigned',
    server: 'string',
    player: 'string',
    reason: 'string',
    timestamp: 'timestamp',
    total: 'integer',
    isVBAN: 'boolean',
  }, {
    autoInc: true,
    indexes:[
      ['server','player'],
      ['timestamp']
    ]
  })

  ctx.model.extend('report_with_evidence', {
    id: 'unsigned',
    reporter_id: 'string',
    reported_id: 'string',
    reason: 'text',
    evidence_path: 'string',
    created_at: 'timestamp',
  })

  ctx.model.extend('report_without_evidence', {
    id: 'unsigned',
    reporter_id: 'string',
    reported_id: 'string',
    reason: 'text',
    created_at: 'timestamp',
  })




  ctx.model.extend('confession_progress', {
    userId: 'string',
    days: 'integer',
    lastDate: 'string',
  },{
    primary: 'userId',
    unique: ['userId']
  })




  //初始化将历史记录给改为false
  ctx.on('ready', async () => {
    await ctx.database.set('ban_records', { 
      isVBAN: null 
    }, {
      isVBAN: false
    })
    ctx.logger('ban').info('已修复历史数据：将null转换为false')
  })

  // 录入踢出消息到数据库
  ctx.middleware(async (session, next) => {




    // 1. 基础条件检查
    if (session.guildId !== config.targetGuild) {
      ctx.logger('ban').debug(`消息来自非目标群组：${session.guildId}`)
      return next()
    }

    if (session.userId !== config.adminUserId1 && session.userId !== config.adminUserId2 && session.userId !== config.adminUserId3) {
      ctx.logger('ban').debug(`非管理员用户踢出功能报告：${session.userId}`)
      return next()
    }

    // if(!session.quote){ 
    //   ctx.logger('ban').debug('消息未引用原始记录')
    //   return next()
    // }

    // 3. 解析被引用的原始消息
    const originalContent = session.content
      .replace(/[\r\n]+/g, ' ') // 处理所有换行符
      .replace(/\s+/g, ' ') // 将换行符替换为空格
      .replace(/[【】]/g, ' ')   // 处理中文括号
      .trim()
    ctx.logger('ban').debug('原始消息内容:', originalContent)

    const pattern = /在服务器\s*(\d+)\s*中踢出玩家\s*([^\s]+?)\s*(?:成功|完成)[\s\S]*原因\s*[:：]\s*([^]+?)(?:$|。)/i
    const match = originalContent.match(pattern)
    if (!match) {
      ctx.logger('ban').debug('消息格式不匹配:',originalContent)
      return next()
    }

    // 3. 提取动态参数
    const [_, server, player, reason] = match.map(s => s?.trim() || '未知')
    ctx.logger('ban').info(`解析到参数：服务器[${server}] 玩家[${player}] 原因[${reason}]`)

    try {
      
      // 4. 创建新记录
      const record = await ctx.database.create('ban_records', {
        server,
        player,
        reason,
        timestamp: new Date(),
      }) as BanRecord

      // 5. 查询当前记录
      const records = await ctx.database.get('ban_records', { server, player }) as BanRecord[]

      // 6. 处理封禁逻辑
      if (records.length >= config.maxViolations) {
          //将以往的数据给删除逻辑先不删除
          //await ctx.database.remove(table, { server, player })
        await session.send([
          `⚠️【自动封禁通知】`,
          `服务器：${server}`,
          `玩家：${player}`,
          `累计违规次数：${records.length}`,
          '最近3次记录：',
          ...records.slice(-3).map(r => 
            `· ${r.timestamp.toLocaleString()} - ${r.reason}`
          ),
          '请立即执行游戏内封禁！'
        ].join('\n'))
      }else {
          await session.send([
            `✅【违规记录更新】`,
            `服务器：${server}`,
            `玩家：${player}`,
            `本次原因：${reason}`,
            `当前累计：${records.length}/${config.maxViolations}`,
            `剩余次数：${config.maxViolations - records.length}`
          ].join('\n'))
        }
    }
    catch (error) {
      ctx.logger('ban').error('数据库操作失败:', error)
      await session.send('❌ 记录保存失败，请检查日志')
    }
  },true)


  // VBAN处理中间件1：处理【服务器】格式
  ctx.middleware(async (session, next) => {
    if (session.guildId !== config.targetGuild) return next()
    if (![config.adminUserId1, config.adminUserId2, config.adminUserId3].includes(session.userId)) return next()

    try {
      // 匹配格式：在服务器【2】中VBAN玩家 XXX 成功 原因：YYY
      const vbanPattern1 = /在服务器【(\d+)】中VBAN玩家\s+([^\s]+)\s+成功\s*原因：\s*(.+)/i
      
      const match = session.content.match(vbanPattern1)
      if (!match) return next()

      const [, server, player, reason] = match.map(s => s.trim())
      ctx.logger('ban').info(`检测到VBAN格式1：服务器[${server}] 玩家[${player}]`)

      // 数据库操作
      const existing = await ctx.database.get('ban_records', { 
        player,
        isVBAN: true 
      })

      if (existing.length > 0) {
        await ctx.database.set('ban_records', { player }, {
          reason: `${reason}（累计处理）`,
          timestamp: new Date(),
          server // 保留原服务器编号
        })
      } else {
        await ctx.database.create('ban_records', {
          server,
          player,
          reason,
          timestamp: new Date(),
          isVBAN: true
        })
      }

      await session.send([
        `✅ 服务器【${server}】VBAN记录已更新`,
        `玩家：${player}`,
        `原因：${reason.slice(0, 50)}${reason.length > 50 ? '...' : ''}`
      ].join('\n'))
      
      return // 终止后续中间件
    } catch (error) {
      ctx.logger('ban').error('VBAN格式1处理失败:', error)
      await session.send('❌ VBAN记录更新失败，请检查日志')
    }
    return next()
  })

  // VBAN处理中间件2：处理*vba命令格式
  ctx.middleware(async (session, next) => {
    if (session.guildId !== config.targetGuild) return next()

    const role = session.event?.member?.roles;
    if(!role.includes('member')){
      return next()
    } 
    else{
      try {
        // 匹配格式：*vba Frenzy488 inferior race
        const vbanPattern2 = /^\*vba\s+(\S+)\s+(.+)/i
        const match = session.content.match(vbanPattern2)
        if (!match) return next()

        const [, player, reason] = match.map(s => s.trim())
        ctx.logger('ban').info(`检测到VBAN格式2：玩家[${player}]`)

        // 数据库操作（强制server=all）
        const existing = await ctx.database.get('ban_records', { 
          player,
          isVBAN: true 
        })

        const finalReason = `重大违规事件：${reason}`
        if (existing.length > 0) {
          await ctx.database.set('ban_records', { player }, {
            reason: `${finalReason}（累计处理）`,
            timestamp: new Date(),
            server: 'all'
          })
        } else {
          await ctx.database.create('ban_records', {
            server: 'all',
            player,
            reason: finalReason,
            timestamp: new Date(),
            isVBAN: true
          })
        }

        await session.send([
          `⚠️ 全局VBAN记录已更新`,
          `玩家：${player}`,
          `标记原因：${finalReason.slice(0, 30)}...`,
          '该玩家将被所有服务器禁止'
        ].join('\n'))
        
        return // 终止后续中间件
      } catch (error) {
        ctx.logger('ban').error('VBAN格式2处理失败:', error)
        await session.send('❌ 全局封禁操作失败')
      }
    }
    return next()
  })


  ctx.middleware(async (session, next) => {
    // 1. 基础验证
    if (session.guildId !== config.targetGuild) return next()
    if (![config.adminUserId1, config.adminUserId2, config.adminUserId3].includes(session.userId)) return next()
  
    // 2. 匹配所有服务器告警
    const matches = Array.from(
      session.content.matchAll(/在服务器\s*\d+\s*中找到相似ID玩家：\s*\d+\s*:\s*(\S+)/g)
    )
    if (matches.length === 0) 
    {
    }
  
    try {
      // 3. 获取群成员列表
      const memberList = await session.bot.internal.getGroupMemberList(session.guildId) as Array<{
        user_id: number
        nickname: string
        card?: string
      }>
  
      // 4. 处理匹配项
      const foundUsers = []
      const notFoundUsers = []
  
      for (const [_, username] of matches) {
        const target = memberList.find(m => 
          [m.nickname, m.card].some(n => 
            n?.includes(username)
        ))
  
        if (target) {
          foundUsers.push({
            qq: target.user_id,
            name: target.card || target.nickname,
            original: username
          })
        } else {
          notFoundUsers.push(username)
        }
      }
  
      // 5. 发送通知
      if (foundUsers.length > 0) {
        const tableContent = [
          "⚠️ 检测到以下用户在群：",
          "===================",
          "QQ号  显示名称  原ID",
          ...foundUsers.map(u => 
            `│ ${u.qq.toString().padEnd(8)} │ ${u.name.padEnd(12)} │ ${u.original.padEnd(10)} │`
          )
        ].join('\n')

        await session.send(tableContent)
      }
  
      // 6. 记录日志
      // ctx.logger('anti-cheat').info([
      //   `群 ${session.guildId}`,
      //   `匹配用户：${foundUsers.map(u => u.original).join(', ')}`,
      //   `未匹配：${notFoundUsers.join(', ')}`,
      //   `操作者：${session.userId}`
      // ].join(' | '))
  
    } catch (error) {
      ctx.logger('anti-cheat').error(`处理失败：${error.message}`)
      await session.send('❌ 用户检测服务暂时不可用').catch(() => {})
    }
  
    return next()
  },true)




  //====================中间件====================
  //--------------------指令---------------------

  //解除vban 
  ctx.command('ban-delete-vban <player:string>', '删除VBAN记录', { authority: 1 })
  .option('global', '-g 删除全局封禁记录')
  .option('server', '-s <server:string> 指定服务器')
  .action(async ({ session, options }, player) => {
    const role = session.event?.member?.roles;
    if(role.includes('member')){
        await session.send('权限不足')
    }
    else{ 
      const where: any = { 
        player,
        isVBAN: true 
      }

      if (options.global) {
        where.server = 'all'
      } else if (options.server) {
        where.server = options.server
      }

      try {
        const result = await ctx.database.remove('ban_records', where)
        const scope = options.global ? '全局' : options.server ? `服务器[${options.server}]` : '所有'
        
        await session.send([
          `✅ 已删除${scope}VBAN记录`,
          `玩家：${player}`,
          `影响记录数：${result}条`
        ].join('\n'))
      } catch (error) {
        ctx.logger('ban').error('VBAN删除失败:', error)
        await session.send('❌ 删除操作失败，请检查格式：\nban-delete-vban <玩家> [-g|-s 服务器]')
      }
    }
  })



  // 查询指令

  ctx.command('ban-check <player:string>', '查询玩家记录', { authority: 1 })
    .option('server', '-s <server:string>')
    .option('page', '-p <page:number>', { fallback: 1 })
    .action(async ({ options }, player) => {
      if (!player) return '请输入玩家ID'

      const where: any = { player }
      if (options.server) where.server = options.server

      try {

        
        const pageSize = 10
        const records = await ctx.database.select('ban_records')
          .where(where)
          .orderBy('timestamp', 'desc')
          .limit(pageSize)
          .offset((options.page - 1) * pageSize)
          .execute() as BanRecord[]

        return [
          '════════ 违规记录查询 ════════',
          `服务器：${options.server || '全部'}`,
          `玩家：${player}`,
          '----------------------------',
          ...records.map(r => [
            `时间：${r.timestamp.toLocaleString()}`,
            `服务器：${r.server}`,
            `原因：${r.reason}`,
            '━━━━━━━━━━━━━━━━━━'
          ].join('\n')),
        ].join('\n')
      } catch (error) {
        ctx.logger('ban').error('查询失败:', error)
        return '查询失败，请检查日志'
      }
    })
  // 在插件代码的适当位置（通常在 apply 函数末尾）添加以下命令
  ctx.command('ban-add <server:string> <player:string> <reason:string>', '手动添加违规记录', { authority: 1 })
    .usage('格式：ban-add <服务器> <玩家ID> <原因>\n示例：ban-add 2 sunrise150 使用外挂')
    .action(async ({ session }, server, player, reason) => {
      // 1. 验证目标群组
      if (session.guildId !== config.targetGuild) {
        await session.send('❌ 此命令只能在指定群组使用')
        return
      }
      const role = session.event?.member?.roles;
      if(role.includes('member')){
        await session.send('权限不足')
        return
      } 

      try {
        // 2. 参数验证（Koishi 会自动验证类型，这里做空值检查）
        if (!server || !player || !reason) {
          return '参数缺失，请按格式输入：ban-add <服务器> <玩家ID> <原因>'
        }

        // 3. 创建记录
        const newRecord = await ctx.database.create('ban_records', {
          server,
          player,
          reason,
          timestamp: new Date()
        }) as BanRecord

        // 4. 构建响应消息
        const response = [
          '✅ 已手动添加违规记录',
          '----------------------------',
          `服务器：${newRecord.server}`,
          `玩家：${newRecord.player}`,
          `原因：${newRecord.reason}`,
          `时间：${newRecord.timestamp.toLocaleString()}`,
          '----------------------------'
        ].join('\n')

        await session.send(response)

      } catch (error) {
        ctx.logger('ban').error('添加记录失败:', error)
        await session.send([
          '❌ 记录添加失败：',
          '1. 请检查玩家ID格式是否正确',
          '2. 确保数据库连接正常',
          '3. 联系日出调整'
        ].join('\n'))
      }
  })
  ctx.command('ban-delete <player:string> [server:string] [sorts:string]', '删除违规记录', { authority: 1 })
  .usage('使用示例：\n'
    + 'ban-delete <玩家ID> - 删除所有服务器中最新的违规记录\n'
    + 'ban-delete <玩家ID> all - 删除所有服务器的所有记录\n'
    + 'ban-delete <玩家ID> <服务器ID> - 删除指定服务器最新记录\n'
    + 'ban-delete <玩家ID> <服务器ID> all - 删除指定服务器的所有记录')
    .action(async ({ session }, player, server, sorts) => {
      // 参数修正逻辑
      if (typeof server === 'string' && server.toLowerCase() === 'all') {
        sorts = 'all'
        server = undefined
      }    
      const role = session.event?.member?.roles;
      if(role.includes('member')){
        await session.send('权限不足')
        return
      } 

      const deleteAll = sorts === 'all'
      const where: any = { player }
      let operationScope = '所有服务器'

      if (server) {
        where.server = server
        operationScope = `服务器 [${server}]`
      }

      try {
        if (deleteAll) {
          // 删除所有记录
          const result:any = await ctx.database.remove('ban_records', where)
          
          if (result === 0) {
            return `❌ 未找到${operationScope}中玩家 [${player}] 的违规记录`
          }

          await session.send([
            `✅ 已删除${operationScope}中玩家 [${player}] 的全部记录`,
            `本次删除记录数：${result} 条`,
            '⚠️ 该操作不可恢复，请谨慎操作'
          ].join('\n'))
        } else {
          // 删除最新记录
          const records = await ctx.database.get('ban_records', where, {
            sort: { timestamp: 'desc' },
            limit: 1
          })

          if (!records.length) {
            return `❌ 未找到${operationScope}中玩家 [${player}] 的违规记录`
          }

          await ctx.database.remove('ban_records', { id: records[0].id })
          
          await session.send([
            `✅ 已删除${operationScope}中玩家 [${player}] 的最新记录`,
            '▸ 时间：' + records[0].timestamp.toLocaleString(),
            '▸ 原因：' + records[0].reason,
            '▸ 服务器：' + records[0].server
          ].join('\n'))
        }
      } catch (error) {
        ctx.logger('ban').error('删除操作失败:', error)
        return [
          '❌ 删除操作失败：',
          '可能原因：',
          '1. 数据库连接异常',
          '2. 玩家ID包含特殊字符',
          '3. 服务器参数格式错误',
          '请检查日志后重试'
        ].join('\n')
      }
  })



  ctx.command('ban-recheck <server:number>', '扫描违规达限玩家', { authority: 1 })
  .usage('输入服务器编号扫描违规达限玩家，例如：ban-recheck 2')
  .action(async ({ session }, server) => {
    if (!server) return '请输入服务器编号'

    try {
      const max = config.maxViolations
      const serverStr = server.toString()

      // 获取该服务器所有记录
      const allRecords = await ctx.database.get('ban_records', {
        server: serverStr,
        $or:[
          {isVBAN: false},
          {isVBAN: null}
        ] // 排除VBAN记录
      })

      // 手动统计玩家违规次数
      const playerCountMap = allRecords.reduce((map, record) => {
        const count = map.get(record.player) || 0
        map.set(record.player, count + 1)
        return map
      }, new Map<string, number>())

      // 筛选达到阈值的玩家
      const violators = Array.from(playerCountMap.entries())
        .filter(([, count]) => count >= max)
        .map(([player]) => player)

      if (violators.length === 0) {
        return `服务器 ${server} 中没有违规达限的玩家`
      }

      return [
        `⚠️ 服务器 ${server} 违规达限玩家列表（${violators.length}人）`,
        '━━━━━━━━━━━━━━━━━━',
        violators.join('\n'),
        '━━━━━━━━━━━━━━━━━━',
        '请及时处理！'
      ].join('\n')

    } catch (error) {
      ctx.logger('ban').error('扫描失败:', error)
      return '扫描操作失败，请联系管理员检查日志'
    }
  })

  ctx.command('ban-setvban <player:string>', '标记玩家为VBAN状态', { authority: 1 })
  .usage('输入要标记的玩家ID，例如：ban-setvban BadPlayer')
  .example('ban-setvban Cheater123  # 将玩家Cheater123标记为VBAN')
  .action(async ({ session ,next}, player) => {
    if (session.guildId !== config.targetGuild) return next()
    try {
      // 1. 查询所有相关记录
      const records = await ctx.database.get('ban_records', { 
        player: player 
      })

      // 2. 检查记录是否存在
      if (records.length === 0) {
        return `❌ 数据库中不存在玩家 "${player}" 的记录`
      }

      // 3. 执行批量更新
      const result = await ctx.database.set('ban_records', 
        { player: player },
        { isVBAN: true }
      )

      // 4. 构建响应信息
      const now = new Date().toLocaleString()
      return [
        `✅ 成功标记VBAN状态`,
        `玩家：${player}`,
        `影响记录数：${result}条`,
        `操作时间：${now}`,
        '已将该玩家所有历史记录标记为全局封禁状态'
      ].join('\n')

    } catch (error) {
      ctx.logger('ban').error('标记VBAN失败:', error)
      return [
        '❌ 操作失败：',
        '可能原因：',
        '1. 数据库连接问题',
        '2. 玩家ID包含特殊字符',
        '3. 数据表权限不足'
      ].join('\n')
    }
  })

  ctx.command('ban-today [server:string]', '查询今日踢人数量', { authority: 1 })
  .usage('输入服务器编号查看今日踢人统计，例如：ban-today 2')
  .example('ban-today  # 查看所有服务器今日踢人')
  .action(async ({ session ,next}, server) => {
    if (session.guildId !== config.targetGuild) return next()
    try {
      // 1. 计算今天的时间范围
      const now = new Date()
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      
      // 2. 构建查询条件
      const where: any = {
        timestamp: {
          $gte: todayStart,
          $lte: now
        }
      }

      // 可选服务器筛选
      if (server) where.server = server

      // 3. 查询数据库
      const records = await ctx.database.get('ban_records', where)

      // 4. 统计结果
      const total = records.length
      const serverCount = new Map<string, number>()
      
      records.forEach(record => {
        const count = serverCount.get(record.server) || 0
        serverCount.set(record.server, count + 1)
      })

      // 5. 构建响应消息
      const serverList = Array.from(serverCount.entries())
        .map(([srv, count]) => `▸ 服务器 ${srv}: ${count} 人`)
        .join('\n')

      return [
        `📊 今日踢人统计（${todayStart.toLocaleDateString()}）`,
        '━━━━━━━━━━━━━━━━━━',
        `总人数：${total} 人`,
        ...(server ? [] : ['按服务器分布：']),
        serverList,
        '━━━━━━━━━━━━━━━━━━',
        total > 0 ? '输入 ban-today-detail <玩家> 查看详细' : ''
      ].filter(Boolean).join('\n')

    } catch (error) {
      ctx.logger('ban').error('查询今日记录失败:', error)
      return [
        '❌ 查询失败：',
        '可能原因：',
        '1. 数据库连接异常',
        '2. 时间参数格式错误',
        '3. 服务器维护中'
      ].join('\n')
    }
  })


  ctx.command('ban-today-detail <server:string>', '查询今日服务器违规详情', { authority: 1 })
  .option('page', '-p <page:number>', { fallback: 1 })
  .option('order', '-o <order:string>', { 
    fallback: 'desc',
  })
  .usage('示例：ban-today-detail 2 -p 1 -o desc')
  .example('ban-today-detail 3 # 查看服务器3今日违规详情')
  .action(async ({ session, options ,next}, server) => {
    if (session.guildId !== config.targetGuild) return next()
    try {
      // 1. 参数验证
      if (!server) return '请输入服务器编号'
      if (!/^\d+$/.test(server)) return '服务器编号必须为数字'

      // 2. 计算时间范围
      const now = new Date()
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())

      // 3. 构建查询条件
      const where = {
        server,
        timestamp: {
          $gte: todayStart,
          $lte: now
        }
      }

      // 4. 分页参数
      const pageSize = 15
      const skip = (options.page - 1) * pageSize

      // 5. 查询数据库
      const records = await ctx.database.get('ban_records', where, {
        sort: { timestamp: options.order === 'asc' ? 'asc' : 'desc' },
        limit: pageSize,
        offset: skip
      }) as BanRecord[]

      // const total = await ctx.database.select('ban_records').where(where).execute(e => e.count())

      // 6. 构建响应消息
      if (records.length === 0) {
        return `ℹ️ 服务器 ${server} 今日暂无违规记录`
      }

      const response = [
        `📋 服务器 ${server} 今日违规详情（第 ${options.page} 页）`,
        '━━━━━━━━━━━━━━━━━━',
        ...records.map((r, i) => {
          const time = r.timestamp.toLocaleTimeString('zh-CN', { 
            hour12: false,
            hour: '2-digit',
            minute: '2-digit'
          })
          return `${i + 1}. [${time}] ${r.player.padEnd(15)}｜原因：${r.reason.slice(0, 20)}${r.reason.length > 20 ? '...' : ''}`
        }),
        '━━━━━━━━━━━━━━━━━━',
        // `共 ${total} 条记录｜当前显示 ${skip + 1}-${skip + records.length} 条`,
        `排序方式：时间${options.order === 'asc' ? '正序 ↑' : '倒序 ↓'}`,
        // total > pageSize ? `使用 -p 参数查看下一页，例如：ban-today-detail ${server} -p ${options.page + 1}` : ''
      ].filter(Boolean).join('\n')

      await session?.send(response)

    } catch (error) {
      ctx.logger('ban').error('详情查询失败:', error)
      return [
        '❌ 查询失败：',
        '可能原因：',
        '1. 数据库连接异常',
        '2. 服务器参数格式错误',
        '3. 分页参数超出范围'
      ].join('\n')
    }
  })


  ctx.command('ban-today-list', '生成今日服务器踢人排行榜', { authority: 1 })
  .action(async ({ session ,next}) => {
    if (session.guildId !== config.targetGuild) return next()
    try {
      // ==================== 数据准备 ====================
      // 1. 获取今日踢人数据
      const now = new Date()
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const records = await ctx.database.get('ban_records', {
        timestamp: { $gte: todayStart }
      })

      // 2. 统计服务器排名
      const serverRank = Array.from(
        records.reduce((map, r) => map.set(r.server, (map.get(r.server) || 0) + 1), new Map<string, number>())
      ).sort((a, b) => b[1] - a[1]).slice(0, 3)

      // ==================== 资源路径配置 ====================
      const ASSETS = {
        // 请修改为你的实际路径
        background: resolve(__dirname, '../assets/rank-bg.png'),
        rankIcons: [
          resolve(__dirname, '../assets/rank-1.png'), // 自动识别为冠军
          resolve(__dirname, '../assets/rank-2.png'), // 自动识别为亚军
          resolve(__dirname, '../assets/rank-3.png')  // 自动识别为季军
        ],
        font: resolve(__dirname, '../fonts/YOUR_FONT.ttf') // 替换为你的字体文件
      }

      // ==================== 智能图标匹配 ====================
      // 通过文件名自动检测图标等级
      const detectRankLevel = (path: string) => {
        const filename = path.toLowerCase().split('/').pop()
        if (filename.includes('1') || filename.includes('gold')) return 1
        if (filename.includes('2') || filename.includes('silver')) return 2
        if (filename.includes('3') || filename.includes('bronze')) return 3
        throw new Error(`无法识别图标等级: ${path}`)
      }

      // 排序图标资源
      const sortedIcons = ASSETS.rankIcons
        .map(path => ({ path, rank: detectRankLevel(path) }))
        .sort((a, b) => a.rank - b.rank)
        .map(item => item.path)

      // ==================== 图片合成 ====================
      // 1. 加载背景图
      const bgImage = sharp(ASSETS.background)
      const bgMetadata = await bgImage.metadata()
      
      // 2. 定义合成位置（根据你的背景图调整）
      const POSITIONS = [
        { x: bgMetadata.width * 0.4, y: bgMetadata.height * 0.15 }, // 冠军位置
        { x: bgMetadata.width * 0.1, y: bgMetadata.height * 0.55 }, // 亚军
        { x: bgMetadata.width * 0.6, y: bgMetadata.height * 0.55 }  // 季军
      ]

       // 动态计算最大图层尺寸
      const MAX_LAYER = {
        width: bgMetadata.width * 0.33,
        height: bgMetadata.height * 0.33
      }
      const composites = []

      for (let i = 0; i < serverRank.length; i++) {
        const [serverId, count] = serverRank[i]
        
        // 调整图标尺寸
        const resizedIcon = await sharp(sortedIcons[i])
          .resize({
            width: Math.min(MAX_LAYER.width, 400),
            height: Math.min(MAX_LAYER.height, 200),
            fit: 'inside'
          })
          .toBuffer()
      

        // 获取实际尺寸
        const iconMeta = await sharp(resizedIcon).metadata()

        // 安全位置计算
        const positions = [
          { 
            x: Math.floor(bgMetadata.width * 0.5 - iconMeta.width / 2),
            y: Math.floor(bgMetadata.height * 0.15)
          },
          { 
            x: Math.floor(bgMetadata.width * 0.2),
            y: Math.floor(bgMetadata.height * 0.6 - iconMeta.height)
          },
          { 
            x: Math.floor(bgMetadata.width * 0.8 - iconMeta.width),
            y: Math.floor(bgMetadata.height * 0.6 - iconMeta.height)
          }
        ]


        // 生成文字层（尺寸适配）
        const textSVG = Buffer.from(`
          <svg width="${iconMeta.width}" height="${iconMeta.height}">
            <style>
              @font-face { 
                font-family: customFont; 
                src: url("file://${ASSETS.font}");
              }
              text { 
                font-family: customFont;
                font-size: ${Math.min(iconMeta.width * 0.1, 42)}px; 
              }
            </style>
            <text x="50%" y="30%" 
                  fill="#FFFFFF" 
                  text-anchor="middle"
                  font-weight="bold">
              ${['🏆 冠军', '🥈 亚军', '🥉 季军'][i]}
            </text>
            <text x="50%" y="60%" 
                  fill="#FFD700" 
                  text-anchor="middle">
              服务器 ${serverId}
            </text>
            <text x="50%" y="80%" 
                  fill="#FFFFFF" 
                  text-anchor="middle">
              ${count}次
            </text>
          </svg>
        `)

        // 合成图层
        const finalLayer = await sharp(resizedIcon)
        .composite([{ input: textSVG, blend: 'over' }])
        .toBuffer()

        composites.push({
          input: finalLayer,
          left: positions[i].x,
          top: positions[i].y
        })
      }

      // 最终合成
      const outputBuffer = await bgImage
        .composite(composites)
        .png()
        .toBuffer()

      await session.send(h.image(outputBuffer, 'image/png'))
    } catch (error) {
      ctx.logger('ban').error('合成失败:', error)
      await session?.send([
        '❌ 排行榜生成失败：',
        '技术细节：' + error.message,
        '请检查：',
        '1. 素材文件尺寸是否过大？',
        '2. 字体文件路径是否正确？',
        '3. 模板位置参数是否需要调整？'
      ].join('\n'))
    }
  })

  ctx.command('导出违规记录 [outputPath]', '导出所有封禁记录到CSV文件')
    .alias('违规记录')
    .option('path', '-p <path> 指定输出文件路径', { fallback: 'ban_records.csv' })
    .action(async ({ options ,session},outputPath) => {
      if(session.userId !== '974111779'){
        return await session.send('❌ 你没有权限执行此操作')
      }
      else{
        const finalPath = outputPath || options.path
        return await exportBanRecordsToCSV(ctx, finalPath)
      }
    })

  
  
  //
  ctx.command('find-user <name:text>', '通过昵称查找QQ群成员')
  .alias('查找用户')
  .usage('输入昵称或群名片进行模糊搜索')
  .example('查找用户 小明')
  .action(async ({ session }, name) => {
    // 验证QQ群环境
    if (!session?.channelId) return '请在企业QQ群聊中使用此命令'

    try {
      // 正确调用OneBot的群成员接口
      const memberList = await session.bot.internal.getGroupMemberList(
        session.channelId // OneBot中使用 channelId 表示QQ群号
      ) as Array<{
        user_id: number    // QQ号（数字类型）
        nickname: string   // 用户昵称
        card?: string      // 群名片（可能为空字符串）
      }>

      // 执行模糊搜索（兼容昵称和群名片）
      const results = memberList.filter(member => {
        const displayName = member.card?.trim() || member.nickname
        return displayName.includes(name)
      })

      // 格式化输出
      if (results.length === 0) {
        return `未找到名称包含「${name}」的群成员`
      }

      const listText = results.map(m => 
        `QQ号：${m.user_id}\n` +
        `${m.card ? `群名片：${m.card}\n昵称：${m.nickname}` : `昵称：${m.nickname}`}`
      ).join('\n\n')

      return `找到 ${results.length} 个匹配成员：\n${listText}`
    } catch (error) {
      console.error('[QQ查人插件] 错误:', error)
      return '查询失败，请确认：\n1. 机器人在群内\n2. 拥有管理员权限'
    }
  })
  //
  ctx.command('忏悔我的罪过')
  .alias('confess')
  .alias('傻逼ft')
  .alias('日出')
  .action(async ({ session }) => {
    const userId = session.username
    const today = new Date().toISOString().split('T')[0]

    try {
      // 查询违规记录（必须包含reason字段）
      const violations = await ctx.database.get('ban_records', 
        { player: userId },
        ['timestamp', 'server', 'reason']  // 明确指定返回字段
      )

      if (violations.length === 0) {
        return `🕊️ 你没有罪过，愿主与你同在 ${session.username}`
      }

      // 获取或初始化进度
      const progress = (await ctx.database.get('confession_progress', { userId }))[0] || {
        userId,
        days: 0,
        lastDate: ''
      }

      // 计算连续天数
      let consecutiveDays = 1
      if (progress.lastDate) {
        const lastDate = new Date(progress.lastDate)
        const todayDate = new Date(today)
        const diffTime = todayDate.getTime() - lastDate.getTime()
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24))
        
        if (diffDays === 0) {
          return `✝️ 你今日已忏悔，请坚持连续三天`
        }
        consecutiveDays = diffDays === 1 ? progress.days + 1 : 1
      }

      // 更新进度
      await ctx.database.upsert('confession_progress', [{
        ...progress,
        days: consecutiveDays,
        lastDate: today
      }])

      // 处理三日忏悔
      //在这里可以设定触发概率
      if (consecutiveDays >= 3) {
        const rand = Math.floor(Math.random() * 10) + 1
        let resultMessage: string

        if (rand <= 7) {
          // 找到最近一次违规
          const latestViolation = violations.sort((a, b) => 
            b.timestamp.getTime() - a.timestamp.getTime())[0]
          
          // 确认reason存在
          if (!latestViolation.reason) {
            throw new Error('违规记录缺少reason字段')
          }

          await ctx.database.remove('ban_records', {
            player: userId,
            timestamp: latestViolation.timestamp
          })
          
          resultMessage = `✨ 神接受了你的忏悔（${rand}/10）\n已免除最近一次违规：\n${latestViolation.reason}`
        } else {
          resultMessage = `⚡️ 收回你的信仰（${rand}/10）\n请继续虔诚悔改`
        }

        // 重置进度
        await ctx.database.remove('confession_progress', { userId })
        return `⛪️ 三日忏悔完成\n${resultMessage}`
      }

      // 未满三日反馈
      return `📖 已记录第 ${consecutiveDays} 日忏悔\n还需坚持 ${3 - consecutiveDays} 天 ${['✨','🕯️','🙏'][consecutiveDays-1]}`

    } catch (error) {
      ctx.logger('confession').error(error)
      return '🛐 忏悔通道受阻，请稍后再试'
    }
  })
  //
  

  


  //命令最后一条使用
}
