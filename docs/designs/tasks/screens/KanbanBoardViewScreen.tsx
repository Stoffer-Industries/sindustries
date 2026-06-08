import React from "react";
import * as Icons from "lucide-react";

export interface KanbanBoardViewScreenProps {
  state: string;
}

/**
 * States:
 * - default: Standard board view with Todo, Doing, Done columns populated with task cards.
 * - dragging: Visualizes a drag operation. A ghost card is present, and the target column (Doing) is highlighted.
 * - inlineExpanded: A task card in the 'Doing' column is expanded to show full details without inputs.
 * - inlineEditing: A task card in the 'Doing' column is expanded and displays input fields for editing.
 */
const KanbanBoardViewScreen: React.FC<KanbanBoardViewScreenProps> = ({ state }) => {
  
  const isInlineExpanded = state === 'inlineExpanded';
  const isInlineEditing = state === 'inlineEditing';
  const isDragging = state === 'dragging';

  // --- Render Helpers ---

  const renderMobileNav = () => (
    <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#1E1E1E] border-t-[3px] border-[#FFE135] h-16 flex items-center justify-around shadow-[0_-4px_0px_0px_rgba(0,0,0,1)]">
      {/* Backlog Tab */}
      <button className="flex flex-col items-center justify-center w-16 h-full text-[#555] hover:text-[#F5F2E8] transition-colors">
        <Icons.LayoutList className="w-6 h-6 mb-1" />
        <span className="text-[10px] font-['Work_Sans'] font-bold uppercase">List</span>
      </button>

      {/* FAB New Task */}
      <button className="relative -top-7 bg-[#FFE135] text-[#1E1E1E] border-[3px] border-[#000000] rounded-full w-14 h-14 flex items-center justify-center shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:scale-105 active:scale-95 transition-transform">
        <Icons.Plus className="w-8 h-8" />
      </button>

      {/* Kanban Tab */}
      <button className="flex flex-col items-center justify-center w-16 h-full text-[#FFE135]">
        <Icons.LayoutDashboard className="w-6 h-6 mb-1" />
        <span className="text-[10px] font-['Work_Sans'] font-bold uppercase">Board</span>
      </button>
    </div>
  );

  const renderHeader = () => (
    <header className="sticky top-0 z-50 bg-[#1E1E1E] border-b-[3px] border-[#FFE135] px-4 py-3 shadow-lg overflow-hidden relative">
      {/* Chevron Pattern Background */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-16 -left-8 w-48 h-48 bg-[#FFE135] opacity-15" style={{ clipPath: 'polygon(100% 0, 0% 100%, 100% 100%)' }}></div>
        <div className="absolute -top-12 left-1/4 w-40 h-40 bg-[#00D4FF] opacity-12" style={{ clipPath: 'polygon(0 0, 100% 0, 50% 100%)' }}></div>
        <div className="absolute -top-8 left-1/2 w-52 h-52 bg-[#FF3E8A] opacity-10" style={{ clipPath: 'polygon(0 0, 100% 0, 0% 100%)' }}></div>
        <div className="absolute -top-20 right-1/4 w-44 h-44 bg-[#FFE135] opacity-12" style={{ clipPath: 'polygon(100% 0, 0% 100%, 100% 100%)' }}></div>
        <div className="absolute -top-16 -right-12 w-56 h-56 bg-[#00D4FF] opacity-15" style={{ clipPath: 'polygon(0 0, 100% 0, 0% 100%)' }}></div>
        <div className="absolute top-0 -right-20 w-40 h-40 bg-[#FF3E8A] opacity-10" style={{ clipPath: 'polygon(100% 0, 0% 100%, 100% 100%)' }}></div>
      </div>
      
      <div className="relative flex flex-col md:flex-row items-center justify-between gap-3">
        {/* Branding & Mobile Controls */}
        <div className="flex items-center justify-between w-full md:w-auto">
          <div className="flex items-center gap-2 group cursor-pointer">
            <div className="bg-[#FFE135] text-[#1E1E1E] px-2 py-1 border-2 border-[#000000] transform -rotate-2 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
              <span className="font-['Dela_Gothic_One'] text-xl md:text-2xl tracking-tight uppercase">Pulse</span>
            </div>
          </div>
        </div>

        {/* Desktop Controls */}
        <div className="hidden md:flex items-center gap-3 w-full md:w-auto h-[44px]">
          <div className="relative w-64 group h-full">
            <div className="absolute inset-y-0 left-0 pl-2 flex items-center pointer-events-none">
              <Icons.Search className="w-4 h-4 text-[#F5F2E8]" />
            </div>
            <input
              type="text"
              placeholder="SEARCH DECK..."
              className="w-full h-full bg-[#2a2a2a] text-[#F5F2E8] pl-9 pr-3 border-2 font-['Work_Sans'] text-sm placeholder-[#888] focus:outline-none focus:border-[#00D4FF] focus:shadow-[2px_2px_0px_0px_rgba(0,212,255,0.5)] transition-all"
            />
          </div>
          <button className="bg-[#2a2a2a] p-2.5 border-2 border-[#555] hover:border-[#00D4FF] transition-colors h-full items-center justify-center">
            <Icons.LayoutList className="w-5 h-5 text-[#F5F2E8]" />
          </button>
          <button className="bg-[#FFE135] text-[#1E1E1E] font-['Dela_Gothic_One'] px-4 py-2 border-2 border-[#000000] shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:translate-y-[1px] hover:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] active:translate-y-[2px] active:shadow-none transition-all flex items-center justify-center gap-2 uppercase tracking-wide h-full">
            <Icons.Plus className="w-4 h-4" />
            New Task
          </button>
        </div>
      </div>

      {/* Mobile Column Indicators */}
      <div className="mt-3 md:hidden flex justify-center gap-2">
        <span className="w-2 h-2 rounded-full bg-[#FFE135]"></span>
        <span className="w-2 h-2 rounded-full bg-[#555]"></span>
        <span className="w-2 h-2 rounded-full bg-[#555]"></span>
      </div>
    </header>
  );

  const renderPriorityBadge = (level: string, small: boolean = false) => {
    const baseClasses = "inline-flex items-center gap-1 border-2 border-[#000000] font-['Work_Sans'] font-bold uppercase tracking-wider ";
    const sizeClasses = small ? "text-[10px] px-1.5 py-0.5" : "text-xs px-2 py-1";
    const shadow = small ? "shadow-[1px_1px_0px_0px_rgba(0,0,0,1)]" : "shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]";

    if (level === 'urgent') {
      return (
        <span className={`${baseClasses} bg-[#FF3E8A] text-white ${sizeClasses} ${shadow}`}>
          <Icons.Flame className={`w-3 h-3 ${small ? 'fill-current' : ''}`} /> Urgent
        </span>
      );
    }
    if (level === 'high') {
      return (
        <span className={`${baseClasses} bg-[#FFE135] text-black ${sizeClasses} ${shadow}`}>
          <Icons.Bolt className={`w-3 h-3 ${small ? 'fill-current' : ''}`} /> High
        </span>
      );
    }
    if (level === 'medium') {
      return (
        <span className={`${baseClasses} bg-[#00D4FF] text-black ${sizeClasses} ${shadow}`}>
          Medium
        </span>
      );
    }
    return (
      <span className={`${baseClasses} bg-[#666666] text-white ${sizeClasses} ${shadow}`}>
        Low
      </span>
    );
  };

  const getAvatarColor = (name: string) => {
    const colors: Record<string, string> = {
      'Alex': 'bg-[#FFE135]',
      'Sam': 'bg-[#00D4FF]',
      'Jordan': 'bg-[#FF3E8A]',
    };
    return colors[name] || 'bg-[#666666]';
  };

  const getInitials = (name: string) => name.charAt(0).toUpperCase();

  const renderAvatar = (assignee: string | null, small: boolean = false) => {
    if (!assignee) return null;
    
    const size = small ? 'w-6 h-6 text-xs' : 'w-8 h-8 text-sm';
    const rotation = assignee === 'Alex' ? 'rotate-[-2deg]' : assignee === 'Jordan' ? 'rotate-[3deg]' : 'rotate-[-1deg]';
    
    return (
      <div className={`inline-flex items-center justify-center rounded-full border-[3px] border-[#000000] shadow-[2px_2px_0px_0px_rgba(0,0,0,0.3)] font-['Dela_Gothic_One'] font-bold text-[#1E1E1E] ${size} ${getAvatarColor(assignee)} ${rotation}`}>
        {getInitials(assignee)}
      </div>
    );
  };

  const renderTaskCard = (
    id: string,
    title: string,
    priority: string,
    assignee: string | null,
    timeInStatus: string,
    tags: string[],
    isExpanded: boolean = false,
    isEditing: boolean = false,
    isGhost: boolean = false
  ) => {
    const rotationClass = !isGhost ? (id === 't1' ? 'rotate-[-1deg]' : id === 't2' ? 'rotate-[1.5deg]' : 'rotate-[-0.5deg]') : 'rotate-0';

    if (isGhost) {
      return (
        <div className={`relative bg-[#F5F2E8] border-[3px] border-[#000000] p-4 mb-4 opacity-50 pointer-events-none ${rotationClass} shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]`}>
          <div className="flex justify-between items-start mb-2 pr-6">
            <h3 className="font-['Work_Sans'] font-bold text-[#1E1E1E] leading-tight text-lg">{title}</h3>
          </div>
          <div className="flex items-center justify-between mt-3">
            {renderPriorityBadge(priority, true)}
            <div className="flex items-center gap-3">
              {renderAvatar(assignee, true)}
              <span className="text-[10px] font-['Work_Sans'] text-[#666] uppercase tracking-wider flex items-center gap-1">
                <Icons.Clock className="w-3 h-3" /> {timeInStatus}
              </span>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className={`relative bg-[#F5F2E8] border-[3px] border-[#000000] p-4 mb-4 cursor-pointer ${rotationClass} shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-1 hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] transition-all duration-200 ${isExpanded ? 'z-10 ring-4 ring-[#00D4FF] rotate-0' : ''}`}>
        <div className="flex justify-between items-start mb-2 pr-6">
          <h3 className={`font-['Work_Sans'] font-bold text-[#1E1E1E] leading-tight ${isExpanded ? 'text-xl' : 'text-lg'}`}>{title}</h3>
        </div>

        <div className="flex items-center justify-between mt-3">
          {renderPriorityBadge(priority, true)}
          <div className="flex items-center gap-3">
            {renderAvatar(assignee, true)}
            <span className="text-[10px] font-['Work_Sans'] text-[#666] uppercase tracking-wider flex items-center gap-1">
              <Icons.Clock className="w-3 h-3" /> {timeInStatus}
            </span>
          </div>
        </div>
      </div>
    );
  };

  const renderColumn = (title: string, count: number, tasks: any[], isDropTarget: boolean = false) => (
    <div className={`flex-none min-w-[90vw] md:min-w-[300px] md:flex-1 bg-[#2a2a2a] border-2 border-[#555] flex flex-col h-full ${isDropTarget ? 'ring-4 ring-[#00D4FF] z-10' : ''}`}>
      <div className="bg-[#1E1E1E] px-4 py-3 border-b-2 border-[#555] flex justify-between items-center sticky top-0 z-10">
        <h2 className="font-['Dela_Gothic_One'] text-lg text-[#F5F2E8] uppercase tracking-wide">{title}</h2>
        <span className="bg-[#555] text-[#F5F2E8] font-['Work_Sans'] font-bold text-xs px-2 py-1 rounded-full">{count}</span>
      </div>
      <div className="p-5 pb-8 flex-1 overflow-y-auto">
        {tasks.map(task => renderTaskCard(task.id, task.title, task.priority, task.assignee, task.timeInStatus, task.tags, task.isExpanded, task.isEditing))}
      </div>
    </div>
  );

  // Mobile Overlay for Expanded State
  const renderMobileOverlay = () => {
    if (!isInlineExpanded && !isInlineEditing) return null;
    
    // The task we are expanding is t4 in the doing list
    const task = doingTasks.find(t => t.id === 't4');

    return (
      <div className="fixed inset-0 z-50 bg-black/50 md:hidden flex items-end">
        <div className="bg-[#F5F2E8] w-full h-[70vh] rounded-t-[20px] border-t-[4px] border-[#000000] p-6 overflow-y-auto shadow-[0_-4px_20px_rgba(0,0,0,0.5)] animate-in slide-in-from-bottom duration-300">
          <div className="w-12 h-1 bg-[#000] rounded-full mx-auto mb-4 opacity-20"></div>
          
          <div className="flex justify-between items-start mb-4">
             <h2 className="font-['Dela_Gothic_One'] text-2xl uppercase text-[#1E1E1E]">{task?.title}</h2>
             <button className="bg-[#FFE135] p-2 border-2 border-[#000] rounded-full">
               <Icons.X className="w-5 h-5" />
             </button>
          </div>

          <div className="flex gap-2 mb-4">
            <span className="bg-[#00D4FF] px-2 py-1 border-2 border-[#000] font-bold text-xs uppercase">Doing</span>
            {renderPriorityBadge('high')}
          </div>

          <p className="font-['Work_Sans'] text-[#1E1E1E] mb-6 leading-relaxed">
             This task involves updating the main landing page graphics to match the new thrashed sticker bomb aesthetic. Needs to be done before the launch party.
          </p>

          {isInlineEditing ? (
             <div className="space-y-6">
               <div>
                 <label className="text-xs font-bold uppercase text-[#666] mb-1 block">Status</label>
                 <select className="w-full bg-white border-2 border-[#000] p-2 font-bold font-['Work_Sans']">
                   <option>Todo</option>
                   <option>Doing</option>
                   <option>Done</option>
                 </select>
               </div>
               <div>
                 <label className="text-xs font-bold uppercase text-[#666] mb-1 block">Priority</label>
                  <div className="grid grid-cols-4 gap-2">
                    {['urgent', 'high', 'medium', 'low'].map((p) => (
                      <button key={p} className={`py-2 text-[10px] font-bold uppercase border-2 border-[#000] font-['Work_Sans'] shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] ${p === 'high' ? 'bg-[#FFE135]' : 'bg-white'}`}>
                        {p}
                      </button>
                    ))}
                  </div>
               </div>
             </div>
          ) : (
             <div className="flex gap-2 mb-4">
               {task?.tags.map(tag => (
                 <span key={tag} className="bg-[#00D4FF] text-[#1E1E1E] text-[11px] font-bold font-['Work_Sans'] px-2.5 py-1 border border-[#000000] inline-block transform -rotate-1">
                   {tag}
                 </span>
               ))}
             </div>
          )}

          {/* Sticky Actions inside Overlay */}
          <div className="mt-auto pt-4 border-t-2 border-dashed border-[#000] flex gap-3 sticky bottom-0 bg-[#F5F2E8] pb-2">
            {isInlineEditing ? (
              <button className="flex-1 bg-[#00D4FF] border-2 border-[#000] font-['Dela_Gothic_One'] uppercase py-3 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">Save</button>
            ) : (
              <>
                <button className="flex-1 bg-[#FFE135] border-2 border-[#000] font-['Work_Sans'] font-bold uppercase py-3 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">Edit</button>
                <button className="flex-1 bg-[#FF3E8A] text-white border-2 border-[#000] font-['Work_Sans'] font-bold uppercase py-3 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">Archive</button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  const todoTasks = [
    { id: 't1', title: 'Design new deck graphics', priority: 'urgent', assignee: 'Alex', timeInStatus: '2d', tags: ['design', 'urgent'], isExpanded: false, isEditing: false },
    { id: 't2', title: 'Order blank decks from supplier', priority: 'high', assignee: 'Sam', timeInStatus: '5d', tags: ['logistics'], isExpanded: false, isEditing: false },
    { id: 't3', title: 'Update website product photos', priority: 'medium', assignee: null, timeInStatus: '1w', tags: ['web'], isExpanded: false, isEditing: false },
  ];

  const doingTasks = [
    { id: 't4', title: 'Create social media campaign assets', priority: 'high', assignee: 'Jordan', timeInStatus: '3d', tags: ['marketing', 'social'], isExpanded: false, isEditing: false }, // Expansion handled by overlay
    { id: 't5', title: 'Test wheel durability samples', priority: 'medium', assignee: 'Alex', timeInStatus: '1d', tags: ['qa', 'testing'], isExpanded: false, isEditing: false },
  ];

  const doneTasks = [
    { id: 't6', title: 'Finalize Q4 budget', priority: 'low', assignee: 'Sam', timeInStatus: '2w', tags: ['finance'], isExpanded: false, isEditing: false },
    { id: 't7', title: 'Ship wholesale order #1042', priority: 'urgent', assignee: null, timeInStatus: '3d', tags: ['fulfillment'], isExpanded: false, isEditing: false },
  ];

  return (
    <div className="min-h-screen bg-[#1E1E1E] flex flex-col">
      {renderHeader()}
      
      <div className="flex-1 p-0 md:p-6 overflow-x-auto relative">
        {/* Ghost card for dragging state */}
        {isDragging && (
          <div className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-50 pointer-events-none hidden md:block">
            {renderTaskCard('t4', 'Create social media campaign assets', 'high', 'Jordan', '3d', ['marketing', 'social'], false, false, true)}
          </div>
        )}
        
        <div className="flex gap-0 md:gap-6 h-full min-h-[calc(100vh-140px)] overflow-x-auto snap-x snap-mandatory md:overflow-visible">
          {renderColumn('Todo', todoTasks.length, todoTasks)}
          {renderColumn('Doing', doingTasks.length, doingTasks, isDragging)}
          {renderColumn('Done', doneTasks.length, doneTasks)}
        </div>
      </div>
      
      {renderMobileNav()}
      {renderMobileOverlay()}
    </div>
  );
};

export default KanbanBoardViewScreen;